'use strict';
const { asyncHandler } = require('../lib/http');

function createDonationController(service) {
  return {
    progress: asyncHandler(async (req, res) => res.status(200).json(await service.progress(req.params.id))),
    create: asyncHandler(async (req, res) => res.status(201).json(await service.create(req.user, req.body))),
    list: asyncHandler(async (req, res) => res.status(200).json(await service.list(req.user, req.query))),
  };
}

module.exports = { createDonationController };
