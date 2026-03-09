const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  unit: { type: String, default: 'шт' },
  aliases: [{ type: String }],
  last_price: { type: Number, default: 0 },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Product', productSchema);
