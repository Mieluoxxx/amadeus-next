import type { FishDiagnostic } from '../shared/voice.ts'

const messages = {
  missing_key: 'No Fish API key is configured. Add a key before requesting speech.',
  invalid_configuration: 'Fish credentials, model and voice must be strings. Correct the saved configuration.',
  invalid_header: 'The API key or model contains invalid HTTP header characters. Re-enter the value without line breaks.',
  connection_setup: 'The WebSocket client could not be created. Check local connection configuration; no synthesis request was started.',
  invalid_request: 'Fish rejected the request parameters. Check the model, voice and audio settings.',
  authentication: 'Fish rejected authentication. Check that the API key is present and valid.',
  payment_required: 'Fish requires payment. Check API balance, credits and billing; this status alone does not identify the exact account restriction.',
  permission_denied: 'Fish denied access. Check account and model permissions.',
  endpoint_not_found: 'The TTS endpoint was not found. Check the API route and service version.',
  method_not_allowed: 'The endpoint rejected the request method. Check WebSocket routing.',
  proxy_authentication: 'The proxy requires authentication. Check proxy credentials, not the Fish API key.',
  request_timeout: 'The server timed out waiting for the request. Check connectivity and try later.',
  request_too_large: 'The request exceeds the accepted size. Reduce request headers or payload size.',
  unsupported_media: 'The request format is unsupported. Check the audio format and protocol version.',
  upgrade_required: 'The server requires a different upgrade. Check WebSocket version and proxy upgrade support.',
  rate_limit: 'Fish rate limit or concurrency limit reached. Wait or reduce concurrent synthesis requests.',
  server_error: 'Fish reported an internal server error. Check service status and try later.',
  gateway_error: 'The gateway received an invalid upstream response. Check service or proxy status.',
  service_unavailable: 'The Fish service is unavailable. Wait and check service status.',
  gateway_timeout: 'The gateway timed out waiting for Fish. Check service status and try later.',
  upgrade_rejected: 'An HTTP response arrived without a WebSocket upgrade. Check the endpoint and proxy configuration.',
  redirect_rejected: 'The endpoint returned a redirect. Verify the official endpoint; credentials are not forwarded automatically.',
  handshake_rejected: 'The WebSocket handshake was rejected for an unclassified reason. Use the HTTP status to investigate.',
  invalid_upgrade: 'The server returned an invalid WebSocket Upgrade header. Check the endpoint and proxy upgrade support.',
  invalid_accept: 'The server returned an invalid Sec-WebSocket-Accept value. Check for an incompatible server or proxy.',
  subprotocol_mismatch: 'The server and client disagree on the WebSocket subprotocol. Check protocol compatibility.',
  extension_mismatch: 'The server returned incompatible WebSocket extensions. Check compression and proxy compatibility.',
  dns_not_found: 'The Fish hostname could not be resolved. Check DNS and the configured network.',
  dns_temporary: 'DNS resolution failed temporarily. Check the resolver or try later.',
  connection_refused: 'The connection was refused. Check the destination, proxy and firewall.',
  connection_reset: 'The connection was reset or its write pipe closed. Check network stability and proxy timeouts.',
  network_unreachable: 'The network is unreachable. Check network routes, VPN and proxy settings.',
  host_unreachable: 'The destination host is unreachable. Check routing and firewall settings.',
  network_timeout: 'The network operation timed out. Check connectivity and proxy availability.',
  handshake_timeout: 'The WebSocket opening handshake timed out. Check connectivity and proxy upgrade support.',
  tls_expired: 'The TLS certificate has expired. Check the system clock and the server or proxy certificate.',
  tls_not_yet_valid: 'The TLS certificate is not yet valid. Check the system clock and certificate dates.',
  tls_revoked: 'The TLS certificate has been revoked. Contact the service or proxy administrator; do not disable certificate verification.',
  tls_hostname: 'The TLS certificate does not match the Fish hostname. Check DNS and proxy interception.',
  tls_untrusted: 'The TLS certificate chain is not trusted. Check the system trust store and proxy certificates; do not disable TLS verification.',
  tls_handshake: 'TLS negotiation failed. Check protocol compatibility and the proxy; do not disable TLS verification.',
  websocket_protocol: 'An invalid WebSocket frame was received. Check the service and proxy protocol compatibility.',
  invalid_http_response: 'The opening HTTP response was malformed. Check the endpoint and proxy.',
  network_unknown: 'A network error occurred without a recognized code. The cause is unknown; check connectivity before retrying.',
  send_failed: 'A Fish protocol message could not be sent. Check connection stability; the text request will not be replayed automatically.',
  decode_failed: 'A response could not be decoded as MessagePack. Check the Fish endpoint and protocol compatibility.',
  invalid_event: 'A decoded response is missing a valid event field. Check service protocol compatibility.',
  invalid_audio: 'An audio event contains invalid PCM bytes. The invalid payload was not played.',
  invalid_finish: 'The service sent an unrecognized completion reason. Completion cannot be assumed.',
  service_error: 'Fish reported a synthesis error after connecting. Check the server detail and model/voice configuration; this is not an opening connection failure.',
  first_audio_timeout: 'No audio arrived within 30s of inactivity after text input ended. Check Fish synthesis availability; do not replay automatically.',
  completion_timeout: 'Audio arrived, but Fish did not send its finish event within 30s of inactivity. The stream is incomplete.',
  closed_without_finish: 'The WebSocket closed normally, but no Fish finish event arrived. Speech completion was not confirmed.',
  peer_going_away: 'The peer closed because it is going away. Check service or proxy availability.',
  protocol_close: 'The peer closed for a WebSocket protocol violation. Check protocol compatibility.',
  unsupported_frame: 'The peer rejected the WebSocket data type. Check binary MessagePack framing.',
  invalid_frame_data: 'The peer rejected invalid frame data. Check encoding and protocol compatibility.',
  close_without_status: 'The connection closed without a status. Completion was not confirmed.',
  abnormal_close: 'The connection ended without a WebSocket close handshake. Check network/proxy stability; the exact cause is unknown.',
  policy_close: 'The service closed for a policy violation. Check its detail and account/request permissions; a close code alone does not prove a billing problem.',
  frame_too_large: 'The peer rejected an oversized WebSocket message. Reduce message size.',
  server_close: 'The service closed after an internal error. Check Fish service status.',
  service_restart: 'The service closed for a restart. Wait before a new request.',
  service_overloaded: 'The service is overloaded and asked to try later. Reduce concurrency or wait.',
  connection_closed: 'The connection closed before Fish confirmed completion. Inspect the close code and server detail; no request is replayed automatically.',
} as const

export type FishFailure = { error: string; diagnostic: FishDiagnostic }
type Phase = FishDiagnostic['phase']
type Evidence = Omit<FishDiagnostic, 'provider' | 'phase' | 'code'>

export function fishFailure(code: keyof typeof messages, phase: Phase, evidence: Evidence = {}): FishFailure {
  const details = [code, evidence.httpStatus !== undefined ? `HTTP ${evidence.httpStatus}` : '', evidence.networkCode || '',
    evidence.closeCode !== undefined ? `WebSocket ${evidence.closeCode}` : '', evidence.event ? `event=${evidence.event}` : ''].filter(Boolean).join(', ')
  const retry = evidence.retryAfterSeconds !== undefined ? ` Retry after at least ${evidence.retryAfterSeconds}s.` : ''
  return {
    error: `Fish ${phase} failed [${details}]: ${messages[code]}${retry}${evidence.detail ? ` Server detail: ${evidence.detail}` : ''}`,
    diagnostic: { provider: 'fish', phase, code, ...evidence },
  }
}

export function fishHttpFailure(status: number | undefined, retryAfter?: unknown): FishFailure {
  const codes: Record<number, keyof typeof messages> = {
    400: 'invalid_request', 401: 'authentication', 402: 'payment_required', 403: 'permission_denied',
    404: 'endpoint_not_found', 405: 'method_not_allowed', 407: 'proxy_authentication', 408: 'request_timeout',
    413: 'request_too_large', 415: 'unsupported_media', 422: 'invalid_request', 426: 'upgrade_required',
    429: 'rate_limit', 500: 'server_error', 502: 'gateway_error', 503: 'service_unavailable', 504: 'gateway_timeout',
  }
  const httpStatus = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  let retryAfterSeconds: number | undefined
  if ((status === 429 || status === 503) && typeof retryAfter === 'string') {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) retryAfterSeconds = seconds
  }
  const code = codes[httpStatus ?? 0] ?? (httpStatus && httpStatus >= 500 ? 'server_error'
    : httpStatus && httpStatus >= 300 && httpStatus < 400 ? 'redirect_rejected'
    : httpStatus && httpStatus < 300 ? 'upgrade_rejected' : 'handshake_rejected')
  return fishFailure(code, 'handshake', { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) })
}

export function fishNetworkFailure(error: unknown, phase: Phase): FishFailure {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  if (value.message === 'Opening handshake has timed out') return fishFailure('handshake_timeout', phase, { networkCode: 'ETIMEDOUT' })
  const openingErrors = new Map<string, keyof typeof messages>([
    ['Invalid Upgrade header', 'invalid_upgrade'], ['Invalid Sec-WebSocket-Accept header', 'invalid_accept'],
    ['Server sent a subprotocol but none was requested', 'subprotocol_mismatch'], ['Server sent an invalid subprotocol', 'subprotocol_mismatch'],
    ['Server sent no subprotocol', 'subprotocol_mismatch'], ['Invalid Sec-WebSocket-Extensions header', 'extension_mismatch'],
    ['Server sent a Sec-WebSocket-Extensions header but no extension was requested', 'extension_mismatch'],
    ['Server indicated an extension that was not requested', 'extension_mismatch'],
  ])
  const openingCode = typeof value.message === 'string' ? openingErrors.get(value.message) : undefined
  if (openingCode) return fishFailure(openingCode, phase)
  const networkCode = typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code) ? value.code : undefined
  const codes: Record<string, keyof typeof messages> = {
    ENOTFOUND: 'dns_not_found', EAI_AGAIN: 'dns_temporary', ECONNREFUSED: 'connection_refused',
    ECONNRESET: 'connection_reset', EPIPE: 'connection_reset', ENETUNREACH: 'network_unreachable', EHOSTUNREACH: 'host_unreachable',
    ETIMEDOUT: 'network_timeout', ESOCKETTIMEDOUT: 'network_timeout', CERT_HAS_EXPIRED: 'tls_expired', CERT_NOT_YET_VALID: 'tls_not_yet_valid',
    ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname', DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_untrusted', SELF_SIGNED_CERT_IN_CHAIN: 'tls_untrusted',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_untrusted', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls_untrusted',
    UNABLE_TO_GET_ISSUER_CERT: 'tls_untrusted', CERT_UNTRUSTED: 'tls_untrusted', CERT_REVOKED: 'tls_revoked',
    ERR_INVALID_CHAR: 'invalid_header', ERR_HTTP_INVALID_HEADER_VALUE: 'invalid_header',
  }
  const code = codes[networkCode ?? ''] ?? (networkCode?.startsWith('ERR_TLS_') || networkCode?.startsWith('ERR_SSL_') ? 'tls_handshake'
    : networkCode?.startsWith('WS_ERR_') ? 'websocket_protocol' : networkCode?.startsWith('HPE_') ? 'invalid_http_response' : 'network_unknown')
  return fishFailure(code, code === 'invalid_header' ? 'configuration' : phase, networkCode ? { networkCode } : {})
}

/** 仅提取显式错误信息并脱敏关键凭证，防止接口私密载荷或请求头泄露给前端。 */
export function fishServerDetail(value: unknown, secret: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let text = value
  if (secret) {
    text = text.replaceAll(secret, '[REDACTED]')
    try { text = text.replaceAll(encodeURIComponent(secret), '[REDACTED]') } catch { /* 避免异常字符编码解析抛错中断脱敏流程 */ }
  }
  return text
    .replace(/(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 320)
}

export function fishCloseFailure(status: number | undefined, phase: Phase, detail?: string): FishFailure {
  const codes: Record<number, keyof typeof messages> = {
    1000: 'closed_without_finish', 1001: 'peer_going_away', 1002: 'protocol_close', 1003: 'unsupported_frame',
    1005: 'close_without_status', 1006: 'abnormal_close', 1007: 'invalid_frame_data', 1008: 'policy_close',
    1009: 'frame_too_large', 1011: 'server_close', 1012: 'service_restart', 1013: 'service_overloaded', 1015: 'tls_handshake',
  }
  const closeCode = status !== undefined && Number.isInteger(status) && status >= 1000 && status <= 4999 ? status : undefined
  return fishFailure(codes[closeCode ?? 0] ?? 'connection_closed', phase, { ...(closeCode !== undefined ? { closeCode } : {}), ...(detail ? { detail } : {}) })
}
