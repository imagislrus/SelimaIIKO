const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Supplier = require('../models/supplier');
const Invoice = require('../models/invoice');
const Product = require('../models/product');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|heic|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Допустимы только изображения (jpg, png, heic, webp)'));
    }
  }
});

// Страница загрузки для поставщика
router.get('/', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(403).send('Доступ запрещён');

  const supplier = await Supplier.findOne({ token });
  if (!supplier) return res.status(403).send('Неверный токен');

  res.sendFile(path.join(__dirname, '..', 'public', 'upload.html'));
});

// Приём фото
router.post('/', upload.array('photos', 10), async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(403).json({ error: 'Доступ запрещён' });

    const supplier = await Supplier.findOne({ token });
    if (!supplier) return res.status(403).json({ error: 'Неверный токен' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Не загружено ни одного фото' });
    }

    const photos = req.files.map(f => f.filename);

    const invoice = await Invoice.create({
      supplier_id: supplier._id,
      photos,
      status: 'processing'
    });

    // Запускаем распознавание асинхронно
    processInvoice(invoice._id, photos).catch(err => {
      console.error('Ошибка обработки накладной:', err);
    });

    res.json({ success: true, invoice_id: invoice._id });
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

async function processInvoice(invoiceId, photos) {
  try {
    const allItems = [];

    for (const photo of photos) {
      const filePath = path.join(__dirname, '..', 'uploads', photo);
      const ocrText = await recognizeWithYandex(filePath);

      if (ocrText) {
        const items = await structureWithClaude(ocrText);
        if (items && items.length > 0) {
          allItems.push(...items);
        }
      }
    }

    let totalSum = 0;
    for (const item of allItems) {
      totalSum += item.sum || 0;
      await updateProductCatalog(item);
    }

    await Invoice.findByIdAndUpdate(invoiceId, {
      items: allItems,
      total_sum: totalSum,
      status: allItems.length > 0 ? 'recognized' : 'error'
    });
  } catch (err) {
    console.error('processInvoice error:', err);
    await Invoice.findByIdAndUpdate(invoiceId, { status: 'error' });
  }
}

async function recognizeWithYandex(filePath) {
  const imageData = fs.readFileSync(filePath);
  const base64 = imageData.toString('base64');

  const body = {
    mimeType: 'image/jpeg',
    languageCodes: ['ru'],
    model: 'handwritten',
    content: base64
  };

  const response = await fetch('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Api-Key ${process.env.YANDEX_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    console.error('Yandex OCR error:', response.status, await response.text());
    return null;
  }

  const data = await response.json();
  const blocks = data.result?.textAnnotation?.blocks || [];
  const lines = [];
  for (const block of blocks) {
    for (const line of (block.lines || [])) {
      const text = line.text || (line.words || []).map(w => w.text).join(' ');
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

async function structureWithClaude(ocrText) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Ты — система распознавания товарных накладных. Из текста ниже извлеки список товаров.
Верни ТОЛЬКО валидный JSON-массив без комментариев. Каждый элемент:
{"name": "название товара", "quantity": число, "unit": "единица измерения", "price": цена за единицу, "sum": итого за позицию}

Если цена или количество неразборчивы — поставь 0.
Единицы: кг, шт, л, уп, пач.

Текст накладной:
${ocrText}`
    }]
  });

  const text = response.content[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]);
  } catch {
    console.error('Не удалось распарсить JSON от Claude:', text);
    return [];
  }
}

async function updateProductCatalog(item) {
  if (!item.name) return;

  const nameLower = item.name.toLowerCase().trim();
  let product = await Product.findOne({
    $or: [
      { name: { $regex: new RegExp(`^${escapeRegex(nameLower)}$`, 'i') } },
      { aliases: { $regex: new RegExp(`^${escapeRegex(nameLower)}$`, 'i') } }
    ]
  });

  if (product) {
    if (item.price > 0) {
      product.last_price = item.price;
      product.updated_at = new Date();
      await product.save();
    }
  } else {
    await Product.create({
      name: item.name,
      unit: item.unit || 'шт',
      aliases: [],
      last_price: item.price || 0
    });
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
