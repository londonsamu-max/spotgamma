import { mysqlTable, serial, varchar, text, int, boolean, json, datetime, index, double } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

// ============ USERS ============
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("open_id", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  loginMethod: varchar("login_method", { length: 50 }),
  role: varchar("role", { length: 50 }).default("user"),
  lastSignedIn: datetime("last_signed_in"),
  createdAt: datetime("created_at").default(sql`NOW()`),
});

export type InsertUser = typeof users.$inferInsert;
export type SelectUser = typeof users.$inferSelect;

// ============ MARKET SNAPSHOTS ============
export const marketSnapshots = mysqlTable("market_snapshots", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  currentPrice: double("current_price").notNull(),
  previousClose: double("previous_close"),
  dailyChange: double("daily_change"),
  dailyChangePct: double("daily_change_pct"),
  callGamma: double("call_gamma"),
  putGamma: double("put_gamma"),
  totalGamma: double("total_gamma"),
  highVolPoint: double("high_vol_point"),
  lowVolPoint: double("low_vol_point"),
  callVolume: double("call_volume"),
  putVolume: double("put_volume"),
  putCallRatio: double("put_call_ratio"),
  ivRank: double("iv_rank"),
  impliedMove: double("implied_move"),
  oneMonthIV: double("one_month_iv"),
  oneMonthRV: double("one_month_rv"),
  topGammaExp: varchar("top_gamma_exp", { length: 50 }),
  rawData: json("raw_data"),
  sessionDate: varchar("session_date", { length: 20 }).notNull(),
  createdAt: datetime("created_at").default(sql`NOW()`),
}, (table) => ({
  symbolIdx: index("symbol_idx").on(table.symbol),
  sessionDateIdx: index("session_date_idx").on(table.sessionDate),
}));

export type InsertMarketSnapshot = typeof marketSnapshots.$inferInsert;
export type SelectMarketSnapshot = typeof marketSnapshots.$inferSelect;

// ============ KEY STRIKES ============
export const keyStrikes = mysqlTable("key_strikes", {
  id: serial("id").primaryKey(),
  snapshotId: int("snapshot_id"),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  strike: double("strike").notNull(),
  callGamma: double("call_gamma"),
  putGamma: double("put_gamma"),
  totalGamma: double("total_gamma"),
  gammaNotional: double("gamma_notional"),
  distanceFromPrice: double("distance_from_price"),
  rank: int("rank"),
  levelType: varchar("level_type", { length: 50 }),
  sessionDate: varchar("session_date", { length: 20 }).notNull(),
  createdAt: datetime("created_at").default(sql`NOW()`),
});

export type InsertKeyStrike = typeof keyStrikes.$inferInsert;
export type SelectKeyStrike = typeof keyStrikes.$inferSelect;

// ============ GEX DATA ============
export const gexData = mysqlTable("gex_data", {
  id: serial("id").primaryKey(),
  gexValue: double("gex_value"),
  gexTrend: varchar("gex_trend", { length: 20 }),
  dealerIntent: text("dealer_intent"),
  keyLevel: double("key_level"),
  rawData: json("raw_data"),
  sessionDate: varchar("session_date", { length: 20 }).notNull(),
  createdAt: datetime("created_at").default(sql`NOW()`),
});

export type InsertGexData = typeof gexData.$inferInsert;
export type SelectGexData = typeof gexData.$inferSelect;

// ============ ALERTS ============
export const alerts = mysqlTable("alerts", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  alertType: varchar("alert_type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  analysis: text("analysis"),
  severity: varchar("severity", { length: 20 }).default("info"),
  strikeLevel: double("strike_level"),
  currentPrice: double("current_price"),
  isRead: boolean("is_read").default(false),
  sessionDate: varchar("session_date", { length: 20 }).notNull(),
  createdAt: datetime("created_at").default(sql`NOW()`),
});

export type InsertAlert = typeof alerts.$inferInsert;
export type SelectAlert = typeof alerts.$inferSelect;

// ============ MARKET NARRATIONS ============
export const marketNarrations = mysqlTable("market_narrations", {
  id: serial("id").primaryKey(),
  narration: text("narration").notNull(),
  context: json("context"),
  sessionDate: varchar("session_date", { length: 20 }).notNull(),
  createdAt: datetime("created_at").default(sql`NOW()`),
});

export type InsertMarketNarration = typeof marketNarrations.$inferInsert;
export type SelectMarketNarration = typeof marketNarrations.$inferSelect;
