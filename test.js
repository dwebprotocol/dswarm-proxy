const test = require('tape')
const crypto = require('crypto')
const DuplexPair = require('duplexpair')
const dswarm = require('@dswarm/network')
const ddatabaseProtocol = require('@ddatabase/protocol')
const ddatabase = require('ddatabase')
const RAM = require('random-access-memory')
const net = require('net')

const DSwarmProxyServer = require('./server')
const DSwarmProxyClient = require('./client')

test('discover and make connections', (t) => {
  // Each test should use a different topic to avoid connecting to other machines running the test
  const TEST_TOPIC = makeTopic('DSWARM-PROXY-TEST' + Math.random())
  const TEST_MESSAGE = 'Hello World'

  t.plan(4)

  const server = new DSwarmProxyServer()
  const network = dswarm({
    socket: (socket) => {
      t.pass('got connection to peer')
      socket.on('data', () => {
        t.pass('got data to peer')
        socket.end(TEST_MESSAGE)
      })
    }
  })

  function cleanupAndExit (e) {
    if (e) t.error(e)
    cleanup(() => {
      process.exit(0)
    })
  }

  function cleanup (cb) {
    server.destroy(() => {
      network.close(cb)
      process.removeListener('SIGINT', cleanupAndExit)
      process.removeListener('uncaughtException', cleanupAndExit)
    })
  }

  process.once('SIGINT', cleanupAndExit)
  process.once('uncaughtException', cleanupAndExit)

  const { socket1: serverSocket, socket2: clientSocket } = new DuplexPair()

  server.handleStream(serverSocket)

  const client = new DSwarmProxyClient({
    connection: clientSocket
  })

  client.on('connection', (connection, info) => {
    t.deepEqual(info.peer.topic, TEST_TOPIC, 'got connection in client')
    connection.on('data', () => {
      t.pass('got data from peer')
      cleanup()
    })
    connection.write(TEST_MESSAGE)
  })

  network.bind(() => {
    network.announce(TEST_TOPIC)
    client.join(TEST_TOPIC)
  })
})

test('handle incoming connections', (t) => {
  const core = ddatabase(RAM)

  const server = new DSwarmProxyServer({
    handleIncoming
  })
  const fakeServer = net.createServer()

  function cleanupAndExit (e) {
    if (e) t.error(e)
    cleanup(() => {
      process.exit(0)
    })
  }

  function cleanup (cb) {
    process.removeListener('SIGINT', cleanupAndExit)
    process.removeListener('uncaughtException', cleanupAndExit)
    server.destroy(() => {
      if (fakeServer.listening) fakeServer.close(cb)
      else process.nextTick(cb)
    })
  }

  process.once('SIGINT', cleanupAndExit)
  process.once('uncaughtException', cleanupAndExit)

  function handleIncoming (socket) {
    t.pass('got incoming connection')
    const stream = ddatabaseProtocol({
      live: true,
      encrypt: true
    })

    socket.pipe(stream).pipe(socket)

    stream.once('feed', (topic) => {
      t.deepEqual(topic, core.discoveryKey, 'got expected topic')
      stream.destroy()
      fakeServer.listen(0, () => {
        const port = fakeServer.address().port

        server.connectClientsTo(topic, port, '127.0.0.1')
      })
    })
  }

  const { socket1: serverSocket, socket2: clientSocket } = new DuplexPair()
  server.handleStream(serverSocket)

  const client = new DSwarmProxyClient({
    connection: clientSocket
  })

  client.once('connection', (connection, info) => {
    t.deepEqual(info.peer.topic, core.discoveryKey, 'got connection in client')
    t.end()

    cleanup()
  })

  core.ready(() => {
    client.join(core.discoveryKey)

    setTimeout(makeIncomingConnection, 500)
  })

  function makeIncomingConnection () {
    const port = server.network.tcp.address().port

    const socket = net.connect(port)
    const stream = core.replicate()

    stream.on('error', () => {
      // whatever
    })

    socket.pipe(stream).pipe(socket)
  }
})

function makeTopic (text) {
  return crypto.createHash('sha256')
    .update(text)
    .digest()
}
