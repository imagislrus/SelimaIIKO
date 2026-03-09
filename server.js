require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '20mb' }));

mongoose.connect(process.env.MONGODB_URI);

const Supplier = mongoose.model('Supplier', new mongoose.Schema({
  name: String, phone: String,
  token: { type: String, unique: true },
  created_at: { type: Date, default: Date.now }
}));

const Product = mongoose.model('Product', new mongoose.Schema({
  name: String, unit: String,
  last_price: Number,
  updated_at: { type: Date, default: Date.now }
}));

const Invoice = mongoose.model('Invoice', new mongoose.Schema({
  supplier_id: mongoose.Schema.Types.ObjectId,
  supplier_name: String,
  received_at: { type: Date, default: Date.now },
  photos: [String], ocr_raw: String,
  items: [{ name: String, unit: String, qty: Number, price: Number, total: Number }],
  total_sum: Number, status: { type: String, default: 'new' },
  payment_status: String, payment_amount: Number,
  items_edited: { type: Boolean, default: false },
  session_id: String, session_index: Number, session_total: Number,
  session_confirmed: { type: Boolean, default: false },
  session_incomplete: { type: Boolean, default: false },
  session_received: Number
}));

const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.get('/upload', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(403).send('Access denied');
  const supplier = await Supplier.findOne({ token });
  if (!supplier) return res.status(403).send('Invalid link');
  let html = fs.readFileSync('public/upload.html', 'utf8');
  html = html.replace('Контрагент', supplier.name);
  res.send(html);
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const { token } = req.query;
  const supplier = await Supplier.findOne({ token });
  if (!supplier) return res.status(403).json({ error: 'Invalid token' });
  const photos = req.files.map(f => f.filename);
  const allItems = [];
  let allRawText = '';
  for (const file of req.files) {
    try {
      const base64 = fs.readFileSync(file.path).toString('base64');
      const yRes = await axios.post('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
        content: base64, mimeType: file.mimetype,
        languageCodes: ['ru', 'en']
      }, { headers: { 'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY } });
      const fullText = yRes.data.result?.textAnnotation?.fullText || '';
      allRawText += fullText + '\n';
      const cRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
        messages: [{ role: 'user', content: 'Extract invoice items. Return ONLY JSON: {"items":[{"name":"","unit":"","qty":0,"price":0,"total":0}],"total_sum":0}\n\nTEXT: ' + fullText }]
      }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
      const raw = cRes.data.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);
      allItems.push(...(parsed.items || []));
    } catch (e) { console.error('Error:', e.message); }
  }
  const invoice = await Invoice.create({
    supplier_id: supplier._id, supplier_name: supplier.name,
    photos, ocr_raw: allRawText, items: allItems,
    total_sum: allItems.reduce((s, i) => s + (i.total || 0), 0),
    payment_status: req.body.payment_status || null,
    payment_amount: req.body.payment_amount ? Number(req.body.payment_amount) : null,
    session_id: req.body.session_id || null,
    session_index: req.body.session_index != null ? Number(req.body.session_index) : null,
    session_total: req.body.session_total != null ? Number(req.body.session_total) : null
  });
  for (const item of allItems) {
    await Product.findOneAndUpdate(
      { name: item.name },
      { unit: item.unit, last_price: item.price, updated_at: new Date() },
      { upsert: true }
    );
  }
  res.json({ success: true, invoice_id: invoice._id });
});

app.get('/api/invoices', async (req, res) => {
  const invoices = await Invoice.find().sort({ received_at: -1 }).limit(100);
  res.json(invoices);
});

app.get('/api/suppliers', async (req, res) => {
  res.json(await Supplier.find());
});

app.post('/api/ocr', async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64) return res.status(400).json({ error: 'No image data' });
  try {
    const yRes = await axios.post('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
      content: base64, mimeType: mimeType || 'image/jpeg',
      languageCodes: ['ru', 'en']
    }, { headers: { 'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY } });
    console.log('Yandex Vision response:', JSON.stringify(yRes.data, null, 2));
    const fullText = yRes.data.result?.textAnnotation?.fullText || '';
    if (!fullText.trim()) return res.json({ rawText: '', parsed: null });
    const cRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
      messages: [{ role: 'user', content: `Это распознанный текст рукописной товарной накладной. Извлеки данные в JSON.

ТЕКСТ:
${fullText}

Верни ТОЛЬКО JSON без markdown:
{
  "number": "номер или null",
  "date": "дата или null",
  "supplier": "контрагент или null",
  "buyer": "покупатель или null",
  "items": [
    { "name": "товар", "unit": "ед", "qty": число, "price": число или null, "total": число или null }
  ],
  "total_sum": число или null
}` }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    let parsed = null;
    try {
      const raw = cRes.data.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch {}
    res.json({ rawText: fullText, parsed });
  } catch (e) {
    console.error('OCR error:', e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.patch('/api/invoices/:id', async (req, res) => {
  try {
    const update = {};
    if (req.body.status) update.status = req.body.status;
    if (req.body.items) { update.items = req.body.items; update.items_edited = true; update.total_sum = req.body.items.reduce((s, i) => s + (i.total || 0), 0); }
    if (req.body.payment_amount != null) update.payment_amount = Number(req.body.payment_amount);
    if (req.body.session_total != null) update.session_total = Number(req.body.session_total);
    const invoice = await Invoice.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/export/csv', async (req, res) => {
  const invoices = await Invoice.find({ status: 'confirmed' }).sort({ received_at: -1 });
  const BOM = '\uFEFF';
  const header = 'Дата,Контрагент,Статус оплаты,Сумма,Товар,Ед.,Кол-во,Цена,Сумма строки';
  const rows = [];
  for (const inv of invoices) {
    const date = inv.received_at ? new Date(inv.received_at).toLocaleDateString('ru') : '';
    const ps = inv.payment_status || '';
    const pa = inv.payment_amount || '';
    for (const item of (inv.items || [])) {
      rows.push([date, inv.supplier_name, ps, pa, item.name, item.unit, item.qty, item.price, item.total].map(v => `"${v ?? ''}"`).join(','));
    }
    if (!inv.items?.length) rows.push([date, inv.supplier_name, ps, pa, '', '', '', '', ''].map(v => `"${v ?? ''}"`).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=invoices.csv');
  res.send(BOM + header + '\n' + rows.join('\n'));
});

app.post('/api/suppliers', async (req, res) => {
  const { name, phone } = req.body;
  const token = crypto.randomBytes(8).toString('hex');
  const supplier = await Supplier.create({ name, phone, token });
  const link = 'https://ibookkeeper.org/upload?token=' + token;
  res.json({ supplier, link });
});



app.post('/api/upload/commit', async (req, res) => {
  const { session_id, session_total, token } = req.body;
  if (!session_id) return res.status(400).json({ ok: false, message: 'No session_id' });
  const received = await Invoice.countDocuments({ session_id });
  if (received !== session_total) {
    await Invoice.updateMany(
      { session_id },
      { $set: { session_incomplete: true, session_total, session_received: received } }
    );
    return res.json({ ok: false, message: `Получено ${received} из ${session_total}` });
  }
  await Invoice.updateMany(
    { session_id },
    { $set: { session_confirmed: true, session_total, session_received: received } }
  );
  res.json({ ok: true });
});

// Check for incomplete sessions every minute
setInterval(async () => {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  await Invoice.updateMany(
    {
      session_id: { $ne: null },
      session_confirmed: { $ne: true },
      session_incomplete: { $ne: true },
      received_at: { $lt: cutoff }
    },
    { $set: { session_incomplete: true } }
  );
}, 60 * 1000);

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'public', 'admin.html')));
app.use(express.static('public'));

app.listen(process.env.PORT, () => console.log('Server on port ' + process.env.PORT));
