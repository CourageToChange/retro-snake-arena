"use strict";

function clientIp(req) {
  const cloudflareIp = firstHeaderValue(req.headers?.["cf-connecting-ip"]);
  if (cloudflareIp) return cloudflareIp;
  const forwardedFor = firstHeaderValue(req.headers?.["x-forwarded-for"]);
  if (forwardedFor) return forwardedFor;
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

module.exports = { clientIp };
