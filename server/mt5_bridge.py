"""
MT5 Bridge — SpotGamma Monitor
Puente entre el servidor Node.js y MetaTrader 5 (Pepperstone)

REQUISITOS:
  pip install MetaTrader5 fastapi uvicorn

IMPORTANTE: Este script debe correr en la misma máquina Windows donde
está instalado MT5. Si usas VPS Windows, córrelo ahí y cambia MT5_BRIDGE_URL
en routers.ts a la IP del VPS (ej: http://45.67.89.10:5001).

INICIO:
  python mt5_bridge.py

  O con uvicorn directamente:
  uvicorn mt5_bridge:app --host 0.0.0.0 --port 5001
"""

import sys
import time
import uvicorn
from datetime import datetime, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# MetaTrader5 solo disponible en Windows
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("⚠️  MetaTrader5 no disponible (requiere Windows). Modo simulación activo.")

app = FastAPI(title="SpotGamma MT5 Bridge", version="1.0.0")

# Permitir llamadas desde el servidor Node.js (localhost)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Configuración Pepperstone ──────────────────────────────────────────────────

# Lot sizes por CFD (según el usuario)
DEFAULT_VOLUME = {
    "NAS100": 0.1,
    "US30":   0.01,
    "XAUUSD": 0.01,
}

# Mapeo de símbolos internos → nombre exacto en Pepperstone MT5
# Ajusta si tu cuenta muestra nombres diferentes (ej: "DJ30", "GOLD", etc.)
SYMBOL_MAP = {
    "NAS100": "NAS100",
    "US30":   "US30",
    "XAUUSD": "XAUUSD",
}

# Magic number para identificar las órdenes del bot
BOT_MAGIC = 20260101

# Desviación máxima (slippage) en puntos
MAX_DEVIATION = 30

# ── Modelos de request/response ────────────────────────────────────────────────

class PlaceOrderRequest(BaseModel):
    cfd: str                     # NAS100, US30, XAUUSD
    direction: str               # LONG o SHORT
    volume: Optional[float] = None  # None = usar DEFAULT_VOLUME
    sl: float                    # Stop Loss precio absoluto
    tp1: float                   # Take Profit 1 (MT5 cierra automáticamente aquí)
    tp2: float                   # Take Profit 2 (para referencia, el bot lo gestiona)
    tp3: float                   # Take Profit 3 (para referencia, el bot lo gestiona)
    comment: str = "SpotGamma"

class ClosePositionRequest(BaseModel):
    ticket: int
    volume: Optional[float] = None  # None = cerrar todo, float = cierre parcial

class ModifySLRequest(BaseModel):
    ticket: int
    new_sl: float
    new_tp: Optional[float] = None  # None = mantener el TP actual

# ── Helpers MT5 ────────────────────────────────────────────────────────────────

def ensure_mt5_connected() -> bool:
    """Intenta reconectar si MT5 se desconectó."""
    if not MT5_AVAILABLE:
        return False
    if not mt5.terminal_info():
        return mt5.initialize()
    return True

def get_fill_mode(symbol: str) -> int:
    """Obtiene el modo de llenado soportado por el símbolo."""
    if not MT5_AVAILABLE:
        return 0
    info = mt5.symbol_info(symbol)
    if not info:
        return mt5.ORDER_FILLING_IOC
    filling = info.filling_mode
    if filling & mt5.ORDER_FILLING_FOK:
        return mt5.ORDER_FILLING_FOK
    if filling & mt5.ORDER_FILLING_IOC:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN

# ── Startup / Shutdown ─────────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    if not MT5_AVAILABLE:
        print("🟡 MT5 Bridge corriendo en MODO SIMULACIÓN (sin MetaTrader5 lib)")
        return
    if not mt5.initialize():
        err = mt5.last_error()
        print(f"❌ No se pudo conectar a MT5: {err}")
        print("   Asegúrate de que MT5 esté abierto y logueado en tu cuenta.")
        # No levantamos excepción — el health endpoint reportará el error
    else:
        info = mt5.account_info()
        if info:
            print(f"✅ MT5 conectado — Cuenta: {info.login} | {info.server}")
            print(f"   Balance: {info.currency} {info.balance:,.2f} | Equity: {info.equity:,.2f}")
        else:
            print("⚠️  MT5 inicializado pero sin info de cuenta. ¿Estás logueado?")

@app.on_event("shutdown")
def shutdown():
    if MT5_AVAILABLE:
        mt5.shutdown()
        print("MT5 desconectado.")

# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Estado de la conexión con MT5 y datos básicos de la cuenta."""
    if not MT5_AVAILABLE:
        return {
            "connected": False,
            "mode": "simulation",
            "error": "MetaTrader5 library not installed (requires Windows)"
        }
    if not ensure_mt5_connected():
        err = mt5.last_error()
        return {"connected": False, "error": str(err)}

    info = mt5.account_info()
    if not info:
        return {"connected": False, "error": "No account info — ¿logueado en MT5?"}

    return {
        "connected": True,
        "mode": "live",
        "account": info.login,
        "server": info.server,
        "balance": round(info.balance, 2),
        "equity": round(info.equity, 2),
        "margin": round(info.margin, 2),
        "freeMargin": round(info.margin_free, 2),
        "profit": round(info.profit, 2),
        "currency": info.currency,
        "leverage": info.leverage,
    }


@app.get("/account")
def get_account():
    """Datos detallados de la cuenta."""
    if not MT5_AVAILABLE:
        return {"error": "MT5 no disponible"}
    if not ensure_mt5_connected():
        raise HTTPException(503, "MT5 no conectado")
    info = mt5.account_info()
    if not info:
        raise HTTPException(503, "Sin info de cuenta")
    return {
        "login": info.login,
        "server": info.server,
        "balance": round(info.balance, 2),
        "equity": round(info.equity, 2),
        "margin": round(info.margin, 2),
        "freeMargin": round(info.margin_free, 2),
        "profit": round(info.profit, 2),
        "currency": info.currency,
        "leverage": info.leverage,
        "tradeMode": info.trade_mode,  # 0=demo, 1=real
    }


@app.post("/place_order")
def place_order(req: PlaceOrderRequest):
    """
    Ejecuta una orden de mercado en MT5 con SL y TP1.
    Devuelve el ticket de la posición o un error detallado.
    """
    if not MT5_AVAILABLE:
        # Modo simulación — devuelve ticket falso
        fake_ticket = int(time.time())
        print(f"[SIM] Orden simulada: {req.direction} {req.cfd} vol={req.volume or DEFAULT_VOLUME.get(req.cfd, 0.01)}")
        return {
            "success": True,
            "simulation": True,
            "ticket": fake_ticket,
            "price": req.sl + 10,  # precio ficticio
            "volume": req.volume or DEFAULT_VOLUME.get(req.cfd, 0.01),
        }

    if not ensure_mt5_connected():
        return {"success": False, "error": "MT5 no conectado"}

    symbol = SYMBOL_MAP.get(req.cfd, req.cfd)
    volume = req.volume if req.volume else DEFAULT_VOLUME.get(req.cfd, 0.01)

    # Activar el símbolo en MT5 si no lo está
    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Símbolo {symbol} no disponible en tu cuenta Pepperstone"}

    # Precio actual
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return {"success": False, "error": f"No se pudo obtener precio de {symbol}"}

    is_long = req.direction == "LONG"
    order_type = mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL
    price = tick.ask if is_long else tick.bid

    # Normalizar SL y TP al número de decimales del símbolo
    sym_info = mt5.symbol_info(symbol)
    digits = sym_info.digits if sym_info else 2
    sl = round(req.sl, digits)
    tp = round(req.tp1, digits)

    # Comment máx 31 chars en MT5
    comment = req.comment[:31]

    request = {
        "action":      mt5.TRADE_ACTION_DEAL,
        "symbol":      symbol,
        "volume":      volume,
        "type":        order_type,
        "price":       price,
        "sl":          sl,
        "tp":          tp,
        "deviation":   MAX_DEVIATION,
        "magic":       BOT_MAGIC,
        "comment":     comment,
        "type_time":   mt5.ORDER_TIME_GTC,
        "type_filling": get_fill_mode(symbol),
    }

    result = mt5.order_send(request)

    if result is None:
        err = mt5.last_error()
        return {"success": False, "error": f"order_send devolvió None: {err}"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "retcode": result.retcode,
            "error": f"{result.comment} (código {result.retcode})",
            "request": {
                "symbol": symbol, "volume": volume, "type": "BUY" if is_long else "SELL",
                "price": price, "sl": sl, "tp": tp,
            }
        }

    print(f"✅ Orden ejecutada: {req.direction} {symbol} #{result.order} @ {result.price} | SL={sl} TP={tp}")
    return {
        "success": True,
        "ticket": result.order,
        "price": result.price,
        "volume": result.volume,
        "symbol": symbol,
    }


@app.post("/close_position")
def close_position(req: ClosePositionRequest):
    """Cierra una posición (total o parcialmente)."""
    if not MT5_AVAILABLE:
        print(f"[SIM] Cierre simulado ticket #{req.ticket}")
        return {"success": True, "simulation": True, "price": 0, "volume": req.volume or 0}

    if not ensure_mt5_connected():
        return {"success": False, "error": "MT5 no conectado"}

    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        return {"success": False, "error": f"Posición #{req.ticket} no encontrada"}

    pos = positions[0]
    volume = round(req.volume, 2) if req.volume else pos.volume
    volume = min(volume, pos.volume)  # No cerrar más de lo que hay

    is_buy = pos.type == mt5.ORDER_TYPE_BUY
    close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(pos.symbol)
    if not tick:
        return {"success": False, "error": "No se pudo obtener precio para cierre"}

    price = tick.bid if is_buy else tick.ask

    request = {
        "action":      mt5.TRADE_ACTION_DEAL,
        "symbol":      pos.symbol,
        "volume":      volume,
        "type":        close_type,
        "position":    req.ticket,
        "price":       price,
        "deviation":   MAX_DEVIATION,
        "magic":       BOT_MAGIC,
        "comment":     "SpotGamma close",
        "type_time":   mt5.ORDER_TIME_GTC,
        "type_filling": get_fill_mode(pos.symbol),
    }

    result = mt5.order_send(request)
    if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
        code = result.retcode if result else "None"
        msg  = result.comment if result else str(mt5.last_error())
        return {"success": False, "error": f"{msg} (código {code})"}

    print(f"✅ Posición #{req.ticket} cerrada @ {result.price} vol={volume}")
    return {
        "success": True,
        "ticket": req.ticket,
        "price": result.price,
        "volume": volume,
    }


@app.post("/modify_sl")
def modify_sl(req: ModifySLRequest):
    """Modifica el Stop Loss (y opcionalmente el TP) de una posición abierta."""
    if not MT5_AVAILABLE:
        print(f"[SIM] Modificar SL ticket #{req.ticket} → {req.new_sl}")
        return {"success": True, "simulation": True}

    if not ensure_mt5_connected():
        return {"success": False, "error": "MT5 no conectado"}

    positions = mt5.positions_get(ticket=req.ticket)
    if not positions:
        return {"success": False, "error": f"Posición #{req.ticket} no encontrada"}

    pos = positions[0]
    sym_info = mt5.symbol_info(pos.symbol)
    digits = sym_info.digits if sym_info else 2

    new_sl = round(req.new_sl, digits)
    new_tp = round(req.new_tp, digits) if req.new_tp else pos.tp

    request = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   pos.symbol,
        "position": req.ticket,
        "sl":       new_sl,
        "tp":       new_tp,
    }

    result = mt5.order_send(request)
    if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
        code = result.retcode if result else "None"
        msg  = result.comment if result else str(mt5.last_error())
        return {"success": False, "error": f"{msg} (código {code})"}

    print(f"✅ SL modificado ticket #{req.ticket}: {pos.sl} → {new_sl}")
    return {"success": True, "newSL": new_sl, "newTP": new_tp}


@app.get("/position/{ticket}")
def get_position(ticket: int):
    """Obtiene el estado actual de una posición. Si ya cerró, busca en historial."""
    if not MT5_AVAILABLE:
        return {"found": False, "simulation": True}

    if not ensure_mt5_connected():
        raise HTTPException(503, "MT5 no conectado")

    # Buscar posición abierta
    positions = mt5.positions_get(ticket=ticket)
    if positions:
        pos = positions[0]
        return {
            "found": True,
            "open": True,
            "ticket": pos.ticket,
            "symbol": pos.symbol,
            "type": "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume": pos.volume,
            "openPrice": pos.price_open,
            "currentPrice": pos.price_current,
            "sl": pos.sl,
            "tp": pos.tp,
            "profit": round(pos.profit, 2),
            "swap": round(pos.swap, 2),
            "openTime": datetime.fromtimestamp(pos.time).isoformat(),
        }

    # Buscar en historial (últimas 30 días)
    from_date = datetime.now() - timedelta(days=30)
    history = mt5.history_orders_get(from_date, datetime.now(), ticket=ticket)
    if history:
        order = history[0]
        return {
            "found": True,
            "open": False,
            "ticket": order.ticket,
            "symbol": order.symbol,
            "state": order.state,
            "volume": order.volume_current,
        }

    return {"found": False}


@app.get("/positions")
def get_all_positions():
    """Lista todas las posiciones abiertas del bot (magic=BOT_MAGIC)."""
    if not MT5_AVAILABLE:
        return {"positions": [], "simulation": True}

    if not ensure_mt5_connected():
        raise HTTPException(503, "MT5 no conectado")

    all_positions = mt5.positions_get()
    if not all_positions:
        return {"positions": []}

    bot_positions = [p for p in all_positions if p.magic == BOT_MAGIC]
    result = []
    for pos in bot_positions:
        result.append({
            "ticket": pos.ticket,
            "symbol": pos.symbol,
            "type": "LONG" if pos.type == mt5.ORDER_TYPE_BUY else "SHORT",
            "volume": pos.volume,
            "openPrice": pos.price_open,
            "currentPrice": pos.price_current,
            "sl": pos.sl,
            "tp": pos.tp,
            "profit": round(pos.profit, 2),
            "swap": round(pos.swap, 2),
            "comment": pos.comment,
        })
    return {"positions": result, "total": len(result)}


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  SpotGamma MT5 Bridge v1.0")
    print("  Pepperstone Demo")
    print("=" * 60)
    uvicorn.run(app, host="127.0.0.1", port=5001, log_level="info")
