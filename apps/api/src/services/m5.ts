/** M5 客服服务装配：复用 t9 的 kill switch / adapter port / confirm token。 */
import type { FastifyInstance } from 'fastify';
import { getRealtimeHub, type RealtimeHub } from '../realtime/hub.js';
import { getWriteGateServices } from '../write-gate/services.js';
import { createReplyDraft, sendReply, type ReplyDeps } from './replies.js';
import { sendQuote, type QuoteDeps } from './quotes.js';
import {
  getConversation,
  listConversations,
  markConversationRead,
  simulateInbound,
  unreadSnapshot,
  type ConversationDeps,
} from './conversations.js';

export interface M5Services {
  conversations: ConversationDeps;
  replies: ReplyDeps;
  quotes: QuoteDeps;
  hub: RealtimeHub;
}

const registry = new WeakMap<FastifyInstance, M5Services>();

export function getM5Services(app: FastifyInstance): M5Services {
  const existing = registry.get(app);
  if (existing) return existing;
  const gate = getWriteGateServices(app);
  const conversations: ConversationDeps = { prisma: app.prisma, audit: app.audit };
  const replies: ReplyDeps = {
    prisma: app.prisma,
    audit: app.audit,
    gateway: app.registry.gateway,
    killSwitch: gate.killSwitch,
    platform: gate.platform,
    confirmTokens: gate.confirmTokens,
  };
  const quotes: QuoteDeps = {
    prisma: app.prisma,
    audit: app.audit,
    killSwitch: gate.killSwitch,
    platform: gate.platform,
    confirmTokens: gate.confirmTokens,
  };
  const services: M5Services = {
    conversations,
    replies,
    quotes,
    hub: getRealtimeHub(app),
  };
  registry.set(app, services);
  return services;
}

export {
  createReplyDraft,
  sendReply,
  sendQuote,
  getConversation,
  listConversations,
  markConversationRead,
  simulateInbound,
  unreadSnapshot,
};
