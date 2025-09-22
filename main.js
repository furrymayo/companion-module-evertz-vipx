import { InstanceBase, TCPHelper, runEntrypoint, InstanceStatus } from '@companion-module/base'
import UpgradeScripts from './upgrades.js'
import { getVariables } from './variables.js'
import { getFeedbacks } from './feedbacks.js'
import { getActions } from './actions.js'

class EvertzVIPXInstance extends InstanceBase {
  constructor(internal) {
    super(internal)

    // state for dynamic choices
    this._connected = false
    this._ifaceVersion = undefined

    this._displays = []
    this._layouts = []
    this._windows = {} // keyed by displayId -> [{id,name}]
    this._inputs  = {} // keyed by displayId -> [{id,name}]
    this._snapshots = []

    // json-rpc plumbing
    this._nextId = 1
    this._pending = new Map()
    this._rxBuffer = ''
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'VIP-X Host/IP',
        width: 6,
        default: '127.0.0.1',
      },
      {
        type: 'number',
        id: 'port',
        label: 'TCP Port',
        width: 3,
        default: 31001,
        min: 1,
        max: 65535,
      },
    ]
  }

  async init(config) {
    this.config = config
    this.updateStatus(InstanceStatus.Connecting)
    this.setVariableDefinitions(getVariables())
    this.setFeedbackDefinitions(getFeedbacks(this))
    this._setInitialVariables()
    this.initTCP()
    this._rebuildActions()
  }

  async configUpdated(config) {
    this.config = config
    this.initTCP()
  }

  async destroy() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = undefined
    }
  }

  _setInitialVariables() {
    this.setVariableValues({
      connected: 'false',
      handshake_version: '',
      last_snapshot_loaded: '',
    })
  }

  initTCP() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = undefined
    }

    this.socket = new TCPHelper(this.config.host, this.config.port)
    this.socket.on('status_change', (status, message) => {
      this.log('debug', `Status: ${status} ${message ?? ''}`)
      if (status === 'connected') {
        this._connected = true
        this.updateStatus(InstanceStatus.Ok)
        this.setVariableValues({ connected: 'true' })
        this.handshake().catch((e) => this.log('error', `Handshake failed: ${e}`))
      } else if (status === 'disconnected') {
        this._connected = false
        this.updateStatus(InstanceStatus.Disconnected)
        this.setVariableValues({ connected: 'false', handshake_version: '' })
      } else if (status === 'connecting') {
        this.updateStatus(InstanceStatus.Connecting)
      }
      this.checkFeedbacks('connected')
    })

    this.socket.on('data', (chunk) => this._onData(chunk))
    this.socket.on('error', (err) => this.log('error', String(err)))
  }

  // --- JSON-RPC helpers ---

  _sendRaw(obj) {
    const payload = JSON.stringify(obj) + '\r\n'
    this.socket?.send(payload)
  }

  async rpc(method, params = undefined) {
    const id = this._nextId++
    const req = { jsonrpc: '2.0', id, method }
    if (params !== undefined) req.params = params

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method })
      this._sendRaw(req)
      // (Optional) timeout
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, 5000)
    })
  }

  async handshake() {
    // Per spec, must be first message from client
    const res = await this.rpc('handshake', { client_supported_versions: [1] })
    const ver = res?.server_selected_version ?? res?.result?.server_selected_version ?? res?.serverSelectedVersion
    this._ifaceVersion = ver ?? 1
    this.setVariableValues({ handshake_version: String(this._ifaceVersion) })
    this.log('info', `Handshake OK. Using interface version ${this._ifaceVersion}`)

    // prime caches
    await this.refreshAll().catch((e) => this.log('error', `Initial refresh failed: ${e}`))
  }

  async refreshAll() {
    try {
      const [displays, layouts, snaps] = await Promise.all([
        this.rpc('get_displays'),
        this.rpc('get_layouts'),
        this.rpc('get_snapshots'),
      ])

      // Normalized extraction (VIP-X replies with {result:{...}})
      this._displays = (displays.result?.displays ?? displays.displays) || []
      this._layouts = (layouts.result?.layouts ?? layouts.layouts) || []
      this._snapshots = (snaps.result?.snapshots ?? snaps.snapshots) || []

      // windows/inputs mapped per display (best-effort fetch)
      for (const d of this._displays) {
        const wid = await this.rpc('get_windows', { display: { id: d.id } }).catch(() => ({}))
        const iid = await this.rpc('get_display_inputs', { display: { id: d.id } }).catch(() => ({}))
        this._windows[d.id] = (wid.result?.windows ?? wid.windows) || []
        this._inputs[d.id] = (iid.result?.inputs ?? iid.inputs) || []
      }

      this._rebuildActions()
      this.checkFeedbacks()
      this.log('debug', `Refreshed: displays=${this._displays.length}, layouts=${this._layouts.length}, snapshots=${this._snapshots.length}`)
    } catch (e) {
      this.log('error', `Refresh error: ${e}`)
      throw e
    }
  }

  _onData(chunk) {
    this._rxBuffer += chunk.toString('utf8')
    let idx
    while ((idx = this._rxBuffer.indexOf('\r\n')) >= 0) {
      const line = this._rxBuffer.slice(0, idx)
      this._rxBuffer = this._rxBuffer.slice(idx + 2)
      if (!line.trim()) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch (e) {
        this.log('error', `JSON parse error: ${e} | data="${line}"`)
        continue
      }

      // Server may send requests (ping, notifications)
      if (msg.method) {
        this._handleServerRequest(msg)
        continue
      }

      // Responses
      if (typeof msg.id !== 'undefined') {
        const pending = this._pending.get(msg.id)
        if (pending) {
          this._pending.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(`${pending.method} -> ${msg.error.message || 'error'}`))
          } else {
            pending.resolve(msg.result ?? msg)
          }
        }
      }
    }
  }

  _handleServerRequest(req) {
    // Reply to ping
    if (req.method === 'ping' && typeof req.id !== 'undefined') {
      this._sendRaw({ jsonrpc: '2.0', id: req.id, result: 'pong' })
      return
    }

    // Notifications: keep local caches in sync
    switch (req.method) {
      case 'notify_create_snapshot':
      case 'notify_modify_snapshot':
      case 'notify_delete_snapshot': {
        const snap = req.params?.snapshot
        if (snap) {
          if (req.method === 'notify_delete_snapshot') {
            this._snapshots = this._snapshots.filter((s) => s.id !== snap.id)
          } else {
            const i = this._snapshots.findIndex((s) => s.id === snap.id)
            if (i >= 0) this._snapshots[i] = snap
            else this._snapshots.push(snap)
          }
          this._rebuildActions()
        }
        break
      }

      case 'notify_create_layout':
      case 'notify_modify_layout':
      case 'notify_delete_layout': {
        const layout = req.params?.layout
        if (layout) {
          if (req.method === 'notify_delete_layout') {
            this._layouts = this._layouts.filter((l) => l.id !== layout.id)
          } else {
            const i = this._layouts.findIndex((l) => l.id === layout.id)
            if (i >= 0) this._layouts[i] = layout
            else this._layouts.push(layout)
          }
          this._rebuildActions()
        }
        break
      }

      case 'notify_create_display':
      case 'notify_modify_display':
      case 'notify_delete_display': {
        const display = req.params?.display
        if (display) {
          if (req.method === 'notify_delete_display') {
            this._displays = this._displays.filter((d) => d.id !== display.id)
            delete this._windows[display.id]
            delete this._inputs[display.id]
          } else {
            const i = this._displays.findIndex((d) => d.id === display.id)
            if (i >= 0) this._displays[i] = display
            else this._displays.push(display)
            // lazily refresh child lists for this display
            this.rpc('get_windows', { display: { id: display.id } })
              .then((w) => (this._windows[display.id] = w.result?.windows ?? w.windows ?? []))
              .catch(() => {})
            this.rpc('get_display_inputs', { display: { id: display.id } })
              .then((i) => (this._inputs[display.id] = i.result?.inputs ?? i.inputs ?? []))
              .catch(() => {})
          }
          this._rebuildActions()
        }
        break
      }

      // We could also ingest set_window_input/audio, set_display_layout notifications if needed
      default:
        // no-op
        break
    }
  }

  _rebuildActions() {
    this.setActionDefinitions(getActions(this))
  }
}

runEntrypoint(EvertzVIPXInstance, UpgradeScripts)
