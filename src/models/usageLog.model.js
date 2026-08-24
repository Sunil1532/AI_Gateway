const mongoose = require('mongoose');

const usageLogSchema = new mongoose.Schema(
  {
    virtualKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VirtualKey',
      required: true,
      index: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    requestId: { type: String },

    requestedModel: { type: String, required: true },
    resolvedModel: { type: String },

    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    costMicros: { type: Number, default: 0 },
    baselineCostMicros: { type: Number, default: 0 },

    cacheHit: { type: Boolean, default: false },
    streamCompleted: { type: Boolean, default: true },

    latencyMs: { type: Number },
  },
  { timestamps: true }
);

usageLogSchema.index({ virtualKeyId: 1, createdAt: -1 });

module.exports = mongoose.model('UsageLog', usageLogSchema);