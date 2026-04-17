module.exports = {
  apps: [
    {
      name: "spotgamma",
      script: "dist/index.js",
      interpreter: "node",
      cwd: "C:/Users/Administrator/Spotgamma",
      env: {
        NODE_ENV: "production",
        PORT: 3099,
        // Auto-trading se gestiona desde data/auto-trading-config.json (via dashboard Bot tab)
        // AUTO_TRADE_MT5 ya no se usa — reemplazado por auto-trading-config.json
      },
      // Auto-restart settings
      restart_delay: 5000,       // wait 5s before restarting
      max_restarts: 10,          // max 10 restarts in watch_delay window
      min_uptime: "10s",         // consider stable if up for 10s
      // Logging
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Instance settings
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
