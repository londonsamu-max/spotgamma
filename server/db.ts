import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  marketSnapshots,
  keyStrikes,
  gexData,
  alerts,
  marketNarrations,
  InsertMarketSnapshot,
  InsertKeyStrike,
  InsertGexData,
  InsertAlert,
  InsertMarketNarration,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;

    textFields.forEach((field) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    });

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Sanitize NaN/Infinity values to null for DB insertion
function sanitizeNumeric(val: number | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && (isNaN(val) || !isFinite(val))) return null;
  return val;
}

function sanitizeSnapshot(data: InsertMarketSnapshot): InsertMarketSnapshot {
  return {
    ...data,
    currentPrice: sanitizeNumeric(data.currentPrice) ?? 0,
    previousClose: sanitizeNumeric(data.previousClose),
    dailyChange: sanitizeNumeric(data.dailyChange),
    dailyChangePct: sanitizeNumeric(data.dailyChangePct),
    callGamma: sanitizeNumeric(data.callGamma),
    putGamma: sanitizeNumeric(data.putGamma),
    totalGamma: sanitizeNumeric(data.totalGamma),
    highVolPoint: sanitizeNumeric(data.highVolPoint),
    lowVolPoint: sanitizeNumeric(data.lowVolPoint),
    callVolume: sanitizeNumeric(data.callVolume),
    putVolume: sanitizeNumeric(data.putVolume),
    putCallRatio: sanitizeNumeric(data.putCallRatio),
    ivRank: sanitizeNumeric(data.ivRank),
    impliedMove: sanitizeNumeric(data.impliedMove),
    oneMonthIV: sanitizeNumeric(data.oneMonthIV),
    oneMonthRV: sanitizeNumeric(data.oneMonthRV),
  };
}

// Market Snapshots
export async function saveMarketSnapshot(data: InsertMarketSnapshot) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(marketSnapshots).values(sanitizeSnapshot(data));
  } catch (err) {
    console.error("[DB] Failed to save market snapshot:", err);
  }
}

export async function getLatestSnapshots(sessionDate: string) {
  const db = await getDb();
  if (!db) return [];
  try {
    const symbols = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA"];
    const results = [];
    for (const symbol of symbols) {
      const rows = await db
        .select()
        .from(marketSnapshots)
        .where(and(eq(marketSnapshots.symbol, symbol), eq(marketSnapshots.sessionDate, sessionDate)))
        .orderBy(desc(marketSnapshots.createdAt))
        .limit(1);
      if (rows.length > 0) results.push(rows[0]);
    }
    return results;
  } catch (err) {
    console.error("[DB] Failed to get snapshots:", err);
    return [];
  }
}

// Key Strikes
export async function saveKeyStrikes(data: InsertKeyStrike[]) {
  const db = await getDb();
  if (!db) return;
  try {
    if (data.length > 0) await db.insert(keyStrikes).values(data);
  } catch (err) {
    console.error("[DB] Failed to save key strikes:", err);
  }
}

export async function getLatestKeyStrikes(symbol: string, sessionDate: string) {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db
      .select()
      .from(keyStrikes)
      .where(and(eq(keyStrikes.symbol, symbol), eq(keyStrikes.sessionDate, sessionDate)))
      .orderBy(desc(keyStrikes.createdAt))
      .limit(3);
  } catch (err) {
    console.error("[DB] Failed to get key strikes:", err);
    return [];
  }
}

// GEX Data
export async function saveGexData(data: InsertGexData) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(gexData).values(data);
  } catch (err) {
    console.error("[DB] Failed to save GEX data:", err);
  }
}

export async function getLatestGexData(sessionDate: string) {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(gexData)
      .where(eq(gexData.sessionDate, sessionDate))
      .orderBy(desc(gexData.createdAt))
      .limit(1);
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error("[DB] Failed to get GEX data:", err);
    return null;
  }
}

// ============================================================
// IN-MEMORY FALLBACK (used when DATABASE_URL is not configured)
// ============================================================
interface MemAlert {
  id: number;
  symbol: string;
  alertType: string;
  title: string;
  message: string;
  analysis?: string | null;
  severity: string;
  strikeLevel?: number | null;
  currentPrice?: number | null;
  isRead: boolean;
  sessionDate: string;
  createdAt: Date;
}
interface MemNarration {
  id: number;
  narration: string;
  context: any;
  sessionDate: string;
  createdAt: Date;
}

let memAlerts: MemAlert[] = [];
let memNarrations: MemNarration[] = [];
let memAlertId = 1;
let memNarrationId = 1;

// Alerts
export async function saveAlert(data: InsertAlert) {
  const db = await getDb();
  if (db) {
    try {
      await db.insert(alerts).values(data);
      const rows = await db
        .select()
        .from(alerts)
        .where(eq(alerts.sessionDate, data.sessionDate))
        .orderBy(desc(alerts.createdAt))
        .limit(1);
      return rows.length > 0 ? rows[0] : null;
    } catch (err) {
      console.error("[DB] Failed to save alert:", err);
    }
  }
  // Fallback to memory
  const alert: MemAlert = {
    id: memAlertId++,
    symbol: data.symbol,
    alertType: data.alertType,
    title: data.title,
    message: data.message,
    analysis: (data as any).analysis || null,
    severity: data.severity || "info",
    strikeLevel: data.strikeLevel ?? null,
    currentPrice: data.currentPrice ?? null,
    isRead: false,
    sessionDate: data.sessionDate,
    createdAt: new Date(),
  };
  memAlerts.unshift(alert);
  // Keep max 200 alerts in memory
  if (memAlerts.length > 200) memAlerts = memAlerts.slice(0, 200);
  return alert;
}

export async function getAlerts(sessionDate: string, limit = 50) {
  const db = await getDb();
  if (db) {
    try {
      return await db
        .select()
        .from(alerts)
        .where(eq(alerts.sessionDate, sessionDate))
        .orderBy(desc(alerts.createdAt))
        .limit(limit);
    } catch (err) {
      console.error("[DB] Failed to get alerts:", err);
    }
  }
  // Fallback to memory
  return memAlerts.filter((a) => a.sessionDate === sessionDate).slice(0, limit);
}

export async function markAlertRead(alertId: number) {
  const db = await getDb();
  if (db) {
    try {
      await db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alertId));
      return;
    } catch (err) {
      console.error("[DB] Failed to mark alert read:", err);
    }
  }
  // Fallback to memory
  const alert = memAlerts.find((a) => a.id === alertId);
  if (alert) alert.isRead = true;
}

// Market Narrations
export async function saveNarration(data: InsertMarketNarration) {
  const db = await getDb();
  if (db) {
    try {
      await db.insert(marketNarrations).values(data);
      return;
    } catch (err) {
      console.error("[DB] Failed to save narration:", err);
    }
  }
  // Fallback to memory
  const narration: MemNarration = {
    id: memNarrationId++,
    narration: data.narration,
    context: data.context,
    sessionDate: data.sessionDate,
    createdAt: new Date(),
  };
  memNarrations.unshift(narration);
  if (memNarrations.length > 50) memNarrations = memNarrations.slice(0, 50);
}

export async function getLatestNarration(sessionDate: string) {
  const db = await getDb();
  if (db) {
    try {
      const rows = await db
        .select()
        .from(marketNarrations)
        .where(eq(marketNarrations.sessionDate, sessionDate))
        .orderBy(desc(marketNarrations.createdAt))
        .limit(1);
      if (rows.length > 0) return rows[0];
    } catch (err) {
      console.error("[DB] Failed to get narration:", err);
    }
  }
  // Fallback to memory
  const found = memNarrations.find((n) => n.sessionDate === sessionDate);
  return found || null;
}

export async function getNarrationHistory(sessionDate: string, limit = 10) {
  const db = await getDb();
  if (db) {
    try {
      return await db
        .select()
        .from(marketNarrations)
        .where(eq(marketNarrations.sessionDate, sessionDate))
        .orderBy(desc(marketNarrations.createdAt))
        .limit(limit);
    } catch (err) {
      console.error("[DB] Failed to get narration history:", err);
    }
  }
  // Fallback to memory
  return memNarrations.filter((n) => n.sessionDate === sessionDate).slice(0, limit);
}
