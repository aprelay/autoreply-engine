module.exports = {
  apps: [{
    name: 'token-sender',
    script: 'server.js',
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      DB_PATH: './data/token-sender.db'
    },
    watch: false,
    instances: 1,
    exec_mode: 'fork'
  }]
}
