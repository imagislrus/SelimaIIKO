const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  received_at: { type: Date, default: Date.now },
  photos: [{ type: String }],
  items: [{
    name: { type: String },
    quantity: { type: Number },
    unit: { type: String },
    price: { type: Number },
    sum: { type: Number }
  }],
  total_sum: { type: Number, default: 0 },
  status: { type: String, enum: ['processing', 'recognized', 'verified', 'error'], default: 'processing' }
});

module.exports = mongoose.model('Invoice', invoiceSchema);
