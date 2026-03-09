const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Invoice = require('../models/invoice');
const Supplier = require('../models/supplier');
const Product = require('../models/product');

// Список накладных
router.get('/', async (req, res) => {
  const { status, supplier_id, limit = 50, skip = 0 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (supplier_id) filter.supplier_id = supplier_id;

  const invoices = await Invoice.find(filter)
    .populate('supplier_id', 'name phone')
    .sort({ received_at: -1 })
    .skip(Number(skip))
    .limit(Number(limit));

  const total = await Invoice.countDocuments(filter);
  res.json({ invoices, total });
});

// Одна накладная
router.get('/:id', async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).populate('supplier_id', 'name phone');
  if (!invoice) return res.status(404).json({ error: 'Не найдена' });
  res.json(invoice);
});

// Обновить накладную (редактирование позиций)
router.put('/:id', async (req, res) => {
  const { items, total_sum, status } = req.body;
  const update = {};
  if (items) update.items = items;
  if (total_sum !== undefined) update.total_sum = total_sum;
  if (status) update.status = status;

  const invoice = await Invoice.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!invoice) return res.status(404).json({ error: 'Не найдена' });
  res.json(invoice);
});

// --- Поставщики ---
router.get('/suppliers/list', async (req, res) => {
  const suppliers = await Supplier.find().sort({ created_at: -1 });
  res.json(suppliers);
});

router.post('/suppliers', async (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажите имя' });

  const token = uuidv4();
  const supplier = await Supplier.create({ name, phone, token });
  res.json(supplier);
});

router.delete('/suppliers/:id', async (req, res) => {
  await Supplier.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// --- Справочник товаров ---
router.get('/products/list', async (req, res) => {
  const products = await Product.find().sort({ updated_at: -1 });
  res.json(products);
});

router.put('/products/:id', async (req, res) => {
  const { name, unit, aliases, last_price } = req.body;
  const update = {};
  if (name) update.name = name;
  if (unit) update.unit = unit;
  if (aliases) update.aliases = aliases;
  if (last_price !== undefined) update.last_price = last_price;
  update.updated_at = new Date();

  const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!product) return res.status(404).json({ error: 'Не найден' });
  res.json(product);
});

router.delete('/products/:id', async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
