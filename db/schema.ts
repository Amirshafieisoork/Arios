import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const state = sqliteTable('arios_state', {
  id: integer('id').primaryKey(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(0),
}, table => [check('arios_state_singleton', sql`${table.id} = 1`)]);

export const settings = sqliteTable('arios_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const drafts = sqliteTable('arios_drafts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull(),
  status: text('status').notNull(),
  transcript: text('transcript').notNull().default(''),
  fields: text('fields').notNull().default('{}'),
  error: text('error'),
  reportId: text('report_id'),
  fileId: text('file_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  claim: text('claim'),
  claimUntil: integer('claim_until').notNull().default(0),
}, table => [index('arios_drafts_user_created').on(table.userId, table.createdAt), index('arios_drafts_status_claim').on(table.status, table.claimUntil)]);

export const telegramLinks = sqliteTable('arios_telegram_links', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  chatId: text('chat_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const linkCodes = sqliteTable('arios_link_codes', {
  codeHash: text('code_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('arios_link_codes_expiry').on(table.expiresAt)]);

export const telegramUpdates = sqliteTable('arios_telegram_updates', {
  updateId: integer('update_id').primaryKey(),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
}, table => [index('arios_telegram_updates_status').on(table.status, table.updateId)]);

export const locks = sqliteTable('arios_locks', {
  name: text('name').primaryKey(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
