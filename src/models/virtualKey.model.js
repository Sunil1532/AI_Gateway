const mongoose = require('mongoose');

const virtualKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },

    keyHash: { type: String, required: true, unique: true, index: true },
    keyPrefix: { type: String, required: true },

    budgetLimitMicros: { type: Number, required: true },
    spentMicros: { type: Number, default: 0 },
    tokensUsed: { type: Number, default: 0 },

    period: { type: String, enum: ['daily', 'monthly', 'lifetime'], default: 'monthly' },
    periodStart: { type: Date, default: Date.now },
       providerApiKeyEncrypted: { type: String },
    providerKeyLabel: { type: String },

    requestsPerMinute: { type: Number, default: 60 },

    status: {
      type: String,
      enum: ['active', 'revoked', 'suspended'],
      default: 'active',
      index: true,
    },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VirtualKey', virtualKeySchema);