module.exports = {
  apps: [
    {
      name: 'autoreply-engine',
      script: 'src/server.js',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      error_file: '/home/user/webapp/logs/error.log',
      out_file: '/home/user/webapp/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
}
