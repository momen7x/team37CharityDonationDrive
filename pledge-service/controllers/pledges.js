'use strict';
const { asyncHandler } = require('../lib/http');

function createPledgeController(service) {
  return {
    create: asyncHandler(async (req, res) => res.status(201).json(await service.create(req.user, req.body))),
    list: asyncHandler(async (req, res) => res.status(200).json(await service.list(req.user, req.query))),
    get: asyncHandler(async (req, res) => res.status(200).json(await service.get(req.user, req.params.id))),
    cancel: asyncHandler(async (req, res) => res.status(200).json(await service.cancel(req.user, req.params.id, req.body))),
    addReceipt: asyncHandler(async (req, res) => res.status(201).json(await service.addReceipt(req.params.id, req.body))),
  };
}

module.exports = { createPledgeController };
