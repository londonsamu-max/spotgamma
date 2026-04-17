/**
 * MT5 File Bridge — SpotGamma Monitor
 *
 * Comunica con el EA SpotGammaBridge.mq5 vía archivos JSON en la
 * carpeta MQL5/Files de MT5 (funciona en macOS con MT5 nativo).
 *
 * Protocolo:
 *   Node.js escribe  → MQL5/Files/sg_order.json
 *   EA ejecuta orden
 *   EA escribe       → MQL5/Files/sg_result.json
 *   Node.js lee resultado y borra ambos archivos
 *   EA actualiza     → MQL5/Files/sg_status.json  (cada ~2.5s)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Ruta a la carpeta Files de MT5 ────────────────────────────────
// Detecta automáticamente el path de MT5 en macOS (Wine/MetaQuotes)
function getMT5FilesPath(): string {
  const override = process.env.MT5_FILES_PATH;
  if (override) return override;

  const home = process.env.HOME || "/Users/" + (process.env.USER || "");
  const winePath = path.join(
    home,
    "Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files"
  );
  if (fs.existsSync(winePath)) return winePath;

  // Fallback: Windows path (si se corre en VPS)
  const winPathAlt = "C:\\Program Files\\MetaTrader 5\\MQL5\\Files";
  return winPathAlt;
}

const MT5_FILES = getMT5FilesPath();
const ORDER_FILE  = path.join(MT5_FILES, "sg_order.json");
const RESULT_FILE = path.join(MT5_FILES, "sg_result.json");
const STATUS_FILE = path.join(MT5_FILES, "sg_status.json");

// ── Tipos ──────────────────────────────────────────────────────────

export interface MT5Status {
  connected: boolean;
  mode?: string;
  account?: number;
  server?: string;
  balance?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  profit?: number;
  currency?: string;
  leverage?: number;
  timestamp?: string;
  error?: string;
  // Live CFD prices from broker (if EA writes them)
  prices?: Record<string, { bid: number; ask: number; time: string }>;
}

export interface MT5OrderResult {
  success: boolean;
  ticket?: number;
  price?: number;
  volume?: number;
  retcode?: number;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeDelete(filePath: string) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ── Serialization lock — only one sendOrder at a time ──
let _sendOrderLock = false;
const _sendOrderQueue: Array<{
  resolve: (r: MT5OrderResult) => void;
  order: Record<string, unknown>;
}> = [];

async function _processNextOrder() {
  if (_sendOrderLock || _sendOrderQueue.length === 0) return;
  _sendOrderLock = true;
  const { resolve, order } = _sendOrderQueue.shift()!;
  try {
    const result = await _sendOrderImpl(order);
    resolve(result);
  } catch (e: any) {
    resolve({ success: false, error: e.message });
  } finally {
    _sendOrderLock = false;
    // Process next in queue (if any)
    if (_sendOrderQueue.length > 0) {
      setTimeout(_processNextOrder, 50);
    }
  }
}

/**
 * Envía una orden al EA y espera el resultado.
 * Timeout: 10 segundos. Serialized — only one order at a time.
 */
async function sendOrder(order: Record<string, unknown>): Promise<MT5OrderResult> {
  return new Promise<MT5OrderResult>((resolve) => {
    _sendOrderQueue.push({ resolve, order });
    _processNextOrder();
  });
}

/** Internal implementation — must only be called via the queue */
async function _sendOrderImpl(order: Record<string, unknown>): Promise<MT5OrderResult> {
  if (!fs.existsSync(MT5_FILES)) {
    return { success: false, error: `MT5 Files folder no encontrada: ${MT5_FILES}` };
  }

  const requestId = crypto.randomBytes(4).toString("hex");
  const payload = JSON.stringify({ ...order, requestId });

  // Limpiar archivos anteriores
  safeDelete(ORDER_FILE);
  safeDelete(RESULT_FILE);

  // Escribir orden para el EA
  fs.writeFileSync(ORDER_FILE, payload, "utf-8");

  // Esperar resultado (poll cada 100ms, timeout 10s)
  const startMs = Date.now();
  while (Date.now() - startMs < 10_000) {
    await new Promise(r => setTimeout(r, 100));
    const result = safeReadJson(RESULT_FILE);
    if (result && result.requestId === requestId) {
      safeDelete(RESULT_FILE);
      return result as MT5OrderResult;
    }
    // Si el EA borró el order file, está procesando — seguir esperando
  }

  safeDelete(ORDER_FILE);
  return { success: false, error: "Timeout: EA no respondió en 10s. ¿Está el EA corriendo?" };
}

// ── API Pública ────────────────────────────────────────────────────

/** Estado de la cuenta MT5 (leído del archivo de status del EA) */
export function getMT5Status(): MT5Status {
  if (!fs.existsSync(MT5_FILES)) {
    return { connected: false, error: `MT5 Files folder no encontrada: ${MT5_FILES}` };
  }

  const status = safeReadJson(STATUS_FILE);
  if (!status) {
    return { connected: false, error: "EA no iniciado o sin status aún. Abre SpotGammaBridge en MT5." };
  }

  // Verificar que el status no sea muy viejo (> 30s = EA pausado)
  if (status.timestamp) {
    const eaTime = new Date(status.timestamp.replace(" ", "T")).getTime();
    const ageMs = Date.now() - eaTime;
    if (ageMs > 30_000) {
      return { ...status, connected: false, error: `EA sin respuesta hace ${Math.round(ageMs/1000)}s` };
    }
  }

  // Prices are now included directly in sg_status.json from the EA

  return status as MT5Status;
}

/** Read live CFD prices from broker (embedded in sg_status.json by EA) */
export function getBrokerPrices(): Record<string, { bid: number; ask: number }> {
  const status = safeReadJson(STATUS_FILE);
  return status?.prices || {};
}

/** Ejecuta una orden de mercado */
export async function placeOrder(params: {
  cfd: string;
  direction: "LONG" | "SHORT";
  volume: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}): Promise<MT5OrderResult> {
  return sendOrder({
    action:    "place_order",
    cfd:       params.cfd,
    direction: params.direction,
    volume:    params.volume,
    sl:        params.sl,
    tp1:       params.tp1,
    tp2:       params.tp2,
    tp3:       params.tp3,
  });
}

/** Cierra una posición (total o parcial) */
export async function closePosition(ticket: number, volume?: number): Promise<MT5OrderResult> {
  return sendOrder({ action: "close_position", ticket, volume: volume ?? 0 });
}

/** Modifica el Stop Loss de una posición abierta */
export async function modifySL(ticket: number, newSL: number, newTP?: number): Promise<MT5OrderResult> {
  return sendOrder({ action: "modify_sl", ticket, new_sl: newSL, new_tp: newTP ?? 0 });
}

/** Export historical candles from MT5 via the EA bridge */
export async function exportHistory(): Promise<MT5OrderResult> {
  return sendOrder({ action: "export_history" });
}

/** Read exported CSV files from MQL5/Files and return as JSON */
export function readExportedHistory(): Record<string, any[]> {
  const result: Record<string, any[]> = {};
  if (!fs.existsSync(MT5_FILES)) return result;

  const files = fs.readdirSync(MT5_FILES).filter((f: string) => f.startsWith("sg_hist_") && f.endsWith(".csv"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(MT5_FILES, file), "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    if (lines.length < 2) continue;

    const headers = lines[0].split(",").map((h: string) => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(",");
      if (vals.length < headers.length) continue;
      const row: Record<string, any> = {};
      headers.forEach((h: string, idx: number) => {
        row[h] = h === "datetime" ? vals[idx]?.trim() : parseFloat(vals[idx]) || 0;
      });
      rows.push(row);
    }
    // sg_hist_NAS100_D1.csv → NAS100_D1
    const key = file.replace("sg_hist_", "").replace(".csv", "");
    result[key] = rows;
  }
  return result;
}

/** Ruta de la carpeta Files detectada (para debug) */
export function getMT5FilesDir(): string {
  return MT5_FILES;
}
