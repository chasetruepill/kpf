import qs from 'querystring'
import { WebSocketHandler } from '@kubernetes/client-node/dist/web-socket-handler'
import WebSocket from 'isomorphic-ws'
import * as net from 'net'
import { PortForward, KubeConfig, CoreV1Api } from '@kubernetes/client-node'
import commandArgs from 'command-line-args'
import * as util from 'util'
import * as child_process from 'child_process'

const pkgJson = require('../package.json')
 
export const kc = new KubeConfig();

kc.loadFromDefault();

export function getLocalCluster() {
  const cluster = kc.getClusters().find(c => c.server === "https://kubernetes.docker.internal:6443")

  if (!cluster) throw new Error('Unable to find Kubernetes for Docker Host.')

  return cluster
}

export async function createClient() {
  kc.setCurrentContext(getLocalCluster().name)

  const requestOpts: any = {};

  kc.applyToRequest(requestOpts);

  return kc.makeApiClient(CoreV1Api);
}

const args = commandArgs([
  { name: 'endpoint', type: String, defaultOption: true },
  { name: 'port', type: Number, alias: 'p', defaultValue: null },
  { name: 'localPort', type: Number, alias: 'l', defaultValue: null },
  { name: 'namespace', type: String, alias: 'n', defaultValue: 'development' },
  { name: 'context', type: String, alias: 'c', defaultValue: null },
  { name: 'version', type: Boolean, alias: 'v', defaultValue: false },
  { name: 'help', type: Boolean, alias: 'h', defaultValue: false },
  { name: 'kill', type: Boolean, alias: 'k', defaultValue: false }
])

function print(obj) {
  console.log(util.inspect(obj, { colors: true, maxArrayLength: 10000, depth: 50 }))
}

// The Websocket and patchForward patches are basically from here: https://github.com/pixel-point/kube-forwarder/blob/master/src/renderer/store/modules/Connections.js

// @ts-ignore
WebSocketHandler.restartableHandleStandardInput = async function (createWS, stdin, streamNum = 0) {
  const tryLimit = 3;
  let queue = Promise.resolve()
  let ws = null

  async function processData(data) {
    const buff = Buffer.alloc(data.length + 1);

    buff.writeInt8(streamNum, 0);
    if (data instanceof Buffer) {
      data.copy(buff, 1);
    } else {
      buff.write(data, 1);
    }

    let i = 0;

    try {
      for (; i < tryLimit; ++i) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(buff);
          break;
        } else {
          ws = await createWS()
        }
      }
    } catch (e) {
      // TODO: Сonsider to log network errors.
      console.error(e)
      stdin.end()
    }

    if (i >= tryLimit) {
      stdin.end()
    }
  }

  stdin.on('data', (data) => {
    // @ts-ignore
    queue = queue.then(processData(data))
  })

  stdin.on('end', () => {
    if (ws) {
      ws.close();
    }
  });

  // It's important to open connection immediately (even without data) for some apps (for example: mariadb)
  try {
    ws = await createWS()
  } catch (e) {
    console.error(e)
  }
}

export function patchForward (forward: PortForward) {
  // @ts-ignore
  forward.portForward = function (namespace, podName, targetPorts, output, err, input) {
    if (targetPorts.length === 0) {
      throw new Error('You must provide at least one port to forward to.')
    }
    if (targetPorts.length > 1) {
      throw(new Error('Only one port is currently supported for port-forward'))
    }

    const queryStr = qs.stringify({
      ports: targetPorts[0]
    })
    const path = `/api/v1/namespaces/${namespace}/pods/${podName}/portforward?${queryStr}`

    const createWebSocket = async () => {
      const needsToReadPortNumber = []
      targetPorts.forEach((_, index) => {
        needsToReadPortNumber[index * 2] = true
        needsToReadPortNumber[index * 2 + 1] = true
      })

      return this.handler.connect(path, null, (streamNum, buff) => {
        if (streamNum >= targetPorts.length * 2) {
          return !this.disconnectOnErr
        }
        // First two bytes of each stream are the port number
        if (needsToReadPortNumber[streamNum]) {
          buff = buff.slice(2)
          needsToReadPortNumber[streamNum] = false
        }
        if (streamNum % 2 === 1) {
          if (err) {
            err.write(buff)
          }
        } else {
          output.write(buff)
        }
        return true
      })
    }

    WebSocketHandler.restartableHandleStandardInput(createWebSocket, input, 0)
  }

  return forward
}

export async function portForward({
  endpoint,
  namespace,
  port,
  localPort = null,
  context = null,
  version = false,
  help = false,
  kill = false,
}: {
  endpoint: string
  namespace: string
  port?: number
  localPort?: number
  context?: string
  version?: boolean
  help?: boolean
  kill?: boolean
}) {
  if (version) {
    console.log(pkgJson.version)
    process.exit(0)
  }

  if (help) {
    console.log(
`Kube Port Forwarder
---------------------
Minimalist Port Forwarder.  Attempts to figure out with minimal information. 
Ports < 1024 require sudo

Usage
  kpf <endpoint>

Endpoint Options
 pod/<pod name>
 service/<service name>
 app/<pod app label>
 <pod name>

Switches
-c (--context)      |  Sets the context (default: docker for mac kubernetes local)
-n (--namespace)    |  Sets the namespace (default: development)
-p (--port)         |  Sets the remote port to connect to (default: first exposed service or pod port)
-l (--localPort)    |  Sets the local bind port (default: remote port)
-k (--kill)         |  Check if Port Being Listened On Already, if not kill it. (OSX ONLY CURRENTLY)

-v (--version)      |   Print the Version String
-h (--help)         |   Print This Output
`      
    )
    process.exit(0)
  }

  const kubernetesContext = context ? { name: context } : getLocalCluster()
  kc.setCurrentContext(kubernetesContext.name)

  console.log('namespace: ', namespace)

  if (!endpoint) throw new Error('Please set the endpoint name.')

  const client = await createClient()

  await client.listNamespace()
    .catch(err => {
      throw new Error('Unable to connect to cluster, is it active?')
    })

  let podName

  async function checkPod() {
    if (!podName) throw new Error('No pod name to check for.')

    return client.readNamespacedPod(podName, namespace)
        .catch(_ => { throw new Error('Pod can not be found.') })
  }

  if (endpoint.startsWith('service/')) {
    const serviceName = endpoint.substr(8)

    console.log('Lookup up service name: ', serviceName)

    await client.readNamespacedService(serviceName, namespace)
      .catch(_ => { throw new Error(`Service could not be found.`) })
    
    console.log("service found")

    const endpoints = (await client.readNamespacedEndpoints(serviceName, namespace)).body

    if (!endpoints.subsets) throw new Error('No active Endpoints found.')

    const target = endpoints.subsets[0]

    if (!port) port = target.ports?.[0]?.port
    podName = target.addresses[0].targetRef.name
  } else {
    if (endpoint.startsWith('app/')) {
      const appName = endpoint.substr(4)

      const pods = (await client.listNamespacedPod(namespace)).body
        .items.filter(p => p.metadata.labels.app === appName && p.status.phase === 'Running')
      
      if (!pods.length) throw new Error('No app found with Pod in Running status phase.')

      podName = pods[0].metadata.name
    } else {
      podName = endpoint.startsWith('pod/') ? endpoint.substr(4) : endpoint
    } 
  }

  const pod = await checkPod()
    
  if (!port) {
    port = pod.body.spec.containers?.[0]?.ports?.[0]?.containerPort
  }

  if (!port) throw new Error('Port could not be determined, set it manually.')
  
  console.log('connect to pod: ', podName)
  console.log("connect on port: ", port)

  const pf = patchForward(new PortForward(kc, true))

  const server = net.createServer(socket => {
    pf.portForward(namespace, podName, [port], socket, null, socket, 3)
  })

  const listenPort = localPort || port

  function getRunning() {
    try {
      return child_process.execSync(`lsof -nP -iTCP:${listenPort} | grep LISTEN`).toString('utf-8')
    } catch (_) {
      return null
    }
  }

  const runningPorts = getRunning()

  if (runningPorts) {
    if (!kill) throw new Error('Port being listened on already, and no kill switch engaged.')
  
    const [_, pid] = runningPorts.split(' ').filter(s => !!s)  
    console.log('killing pid: ', pid)

    child_process.execSync(`kill -9 ${pid}`)
    while (getRunning()) {}
  }

  server.listen(listenPort, 'localhost', () => {
    console.log(`listening on localhost:${listenPort}`)
  })
}

// @ts-ignore
portForward(args)
  .catch((err: Error) => {
    console.error(err.message)
    process.exit(1)
  })