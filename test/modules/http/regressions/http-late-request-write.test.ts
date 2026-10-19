// @vitest-environment node
/**
 * @see https://github.com/mswjs/interceptors/issues/862
 */
import http from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { BatchInterceptor } from '#/src/batch-interceptor'
import { ClientRequestInterceptor } from '#/src/interceptors/ClientRequest'
import { FetchInterceptor } from '#/src/interceptors/fetch/node'
import { createRawTestServer, toWebResponse } from '#/test/helpers'

const interceptor = new BatchInterceptor({
  name: 'interceptor',
  interceptors: [new ClientRequestInterceptor(), new FetchInterceptor()],
})

beforeAll(() => {
  interceptor.apply()
})

afterEach(() => {
  interceptor.removeAllListeners()
})

afterAll(() => {
  interceptor.dispose()
})

/**
 * A server that counts the connections it accepts. Every request in
 * this suite is mocked, so it must never accept any.
 */
async function createConnectionCountingServer() {
  const connectionListener = vi.fn()
  const server = await createRawTestServer(() => {
    return http
      .createServer((_request, response) => {
        response.end('original')
      })
      .on('connection', connectionListener)
  })

  return Object.assign(server, { connectionListener })
}

it('mocks a fetch request whose streamed body arrives late', async () => {
  await using server = await createConnectionCountingServer()

  const requestListener = vi.fn<(body: string) => void>()
  interceptor.on('request', async ({ request, controller }) => {
    requestListener(await request.text())
    controller.respondWith(new Response('mocked'))
  })

  /**
   * @note Undici starts reading the socket once it connects but writes
   * the request only once the body yields its first chunk. With
   * "highWaterMark: 0", the stream pulls that chunk only when Undici
   * reads the body, so the socket stays silent until then.
   */
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await setTimeout(100)
        controller.enqueue(new TextEncoder().encode('hello world'))
        controller.close()
      },
    },
    { highWaterMark: 0 }
  )

  const response = await fetch(server.http.url('/resource'), {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit)

  expect.soft(response.status).toBe(200)
  await expect.soft(response.text()).resolves.toBe('mocked')
  expect.soft(requestListener).toHaveBeenCalledExactlyOnceWith('hello world')
  expect(server.connectionListener).not.toHaveBeenCalled()
})

it('mocks an HTTP request that ends late', async () => {
  await using server = await createConnectionCountingServer()

  const requestListener = vi.fn<(body: string) => void>()
  interceptor.on('request', async ({ request, controller }) => {
    requestListener(await request.text())
    controller.respondWith(new Response('mocked'))
  })

  const request = http.request(server.http.url('/resource'), {
    method: 'POST',
    agent: false,
  })
  globalThis.setTimeout(() => request.end('hello world'), 100)

  const [response] = await toWebResponse(request)

  expect.soft(response.status).toBe(200)
  await expect.soft(response.text()).resolves.toBe('mocked')
  expect.soft(requestListener).toHaveBeenCalledExactlyOnceWith('hello world')
  expect(server.connectionListener).not.toHaveBeenCalled()
})
