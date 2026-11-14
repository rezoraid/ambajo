import { createApp } from './app.js'
import { config } from './config.js'

const app = await createApp(config).catch(e => {
  console.error('Gagal start:', e)
  process.exit(1)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    app.log.info({ sig }, 'shutting down')
    app.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}

await app.listen({ port: config.port, host: config.host })
