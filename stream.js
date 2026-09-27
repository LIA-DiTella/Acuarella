// Transmisión del acuario a una tele por la red local, sin servidor propio.
//
// La computadora que dibuja abre el emisor (aquarium.html?emitir), captura su propio canvas y lo manda por WebRTC.
// La tele abre tv.html y solo reproduce el video, así no necesita potencia para dibujar el arrecife.
// Supabase Realtime es el punto de encuentro: por ahí pasan los mensajes que arman la conexión, pero el video va
// directo de la computadora a la tele. La tele se empareja una vez con un código de 3 cifras que muestra en
// pantalla; en ese paso recibe un secreto largo, que nombra el canal de la transmisión y nunca se muestra.
//
// Sintaxis conservadora a propósito (sin ?. ni ??, offer/answer explícitos): los navegadores de las teles suelen
// ser Chromium viejos.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_TELES = 3;
const LETRAS = 'abcdefghjkmnpqrstuvwxyz23456789';  // sin i, l, o, 0 ni 1, que se confunden al tipear

/** Secreto de un canal de transmisión: 16 caracteres (unos 80 bits). Nunca se muestra en pantalla. */
export function nuevoSecreto() {
  const azar = crypto.getRandomValues(new Uint8Array(16));
  let secreto = '';
  for (let i = 0; i < azar.length; i++) secreto += LETRAS[azar[i] % LETRAS.length];
  return secreto;
}

export function secretoValido(secreto) {
  return /^[a-hjkmnp-z2-9]{16}$/.test(secreto);
}

/**
 * Código de emparejamiento: 3 cifras, fácil de tipear. Solo sirve mientras la tele lo muestra; la transmisión usa
 * después el secreto largo, así que adivinar las 3 cifras no alcanza para ver ni para meterse en una tele emparejada.
 */
export function nuevoCodigo() {
  return String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, '0');
}

export function normalizarCodigo(texto) {
  return String(texto || '').replace(/[^0-9]/g, '');
}

export function codigoValido(codigo) {
  return /^[0-9]{3}$/.test(codigo);
}

const conectada = (pc) => pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';

/**
 * Canal de Supabase Realtime con el protocolo Phoenix, sin supabase-js. Se reconecta solo.
 * `alUnirse` corre cada vez que queda unido, también después de una reconexión.
 */
function abrirCanal(nombre, alRecibir, alUnirse) {
  const topic = 'realtime:tele-' + nombre;
  const url = SUPABASE_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' +
    encodeURIComponent(SUPABASE_KEY) + '&vsn=1.0.0';
  let ws = null, ref = 0, joinRef = null, latido = null, unido = false, cerrado = false;
  const cola = [];

  const mandar = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const publicar = (mensaje) => mandar({
    topic, event: 'broadcast', ref: String(++ref), join_ref: joinRef,
    payload: { type: 'broadcast', event: 'senal', payload: mensaje },
  });

  function conectar() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      joinRef = String(++ref);
      mandar({
        topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } },
      });
      latido = setInterval(() => mandar({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }), 25000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.topic !== topic) return;
      if (m.event === 'phx_reply' && m.ref === joinRef) {
        if (m.payload && m.payload.status === 'ok') {
          unido = true;
          while (cola.length) publicar(cola.shift());
          alUnirse();
        } else {
          console.warn('Realtime rechazó el canal', m.payload);
        }
      } else if (m.event === 'broadcast' && m.payload && m.payload.event === 'senal' && m.payload.payload) {
        alRecibir(m.payload.payload);
      }
    };
    ws.onclose = () => {
      clearInterval(latido);
      unido = false;
      if (!cerrado) setTimeout(conectar, 2000);
    };
  }

  conectar();
  return {
    enviar(mensaje) {
      if (unido) publicar(mensaje);
      else if (cola.length < 50) cola.push(mensaje);
    },
    cerrar() {
      cerrado = true;
      if (ws) ws.close();
    },
  };
}

/** H.264 primero: las teles lo decodifican por hardware y la Mac lo codifica por hardware. */
function preferirH264(transceptor) {
  if (!transceptor.setCodecPreferences || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
  const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
  const esH264 = (c) => /h264/i.test(c.mimeType);
  if (!codecs.some(esH264)) return;
  try {
    transceptor.setCodecPreferences(codecs.filter(esH264).concat(codecs.filter((c) => !esH264(c))));
  } catch (err) {
    console.warn(err);
  }
}

/**
 * Emite `canvas` para las teles emparejadas con `secreto`.
 * `opciones`: { fps, bitrate, alCambiar(n) } — alCambiar informa cuántas teles están recibiendo.
 */
export function emitir(canvas, secreto, opciones) {
  const o = opciones || {};
  const fps = o.fps || 60, bitrate = o.bitrate || 25000000;
  const alCambiar = o.alCambiar || (() => {}), alFallar = o.alFallar || (() => {});
  const video = canvas.captureStream(fps);
  const teles = new Map();  // id de la tele → RTCPeerConnection

  const contar = () => {
    let n = 0;
    teles.forEach((pc) => { if (conectada(pc)) n++; });
    alCambiar(n);
  };

  function cerrar(id) {
    const pc = teles.get(id);
    if (!pc) return;
    pc.close();
    teles.delete(id);
    contar();
  }

  async function ofrecer(id) {
    cerrar(id);
    if (teles.size >= MAX_TELES) cerrar(teles.keys().next().value);  // la más vieja
    const pc = new RTCPeerConnection({ iceServers: ICE });
    teles.set(id, pc);
    const pista = video.getVideoTracks()[0];
    if ('contentHint' in pista) pista.contentHint = 'motion';
    const transceptor = pc.addTransceiver(pista, { direction: 'sendonly', streams: [video] });
    preferirH264(transceptor);
    pc.onicecandidate = (e) => {
      if (e.candidate) canal.enviar({ tipo: 'ice', de: 'emisor', para: id, candidato: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && teles.get(id) === pc) {
        cerrar(id);
        alFallar();  // la señal llegó pero la conexión directa no: red distinta o IPs ocultas en Chrome
      } else {
        contar();
      }
    };
    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    canal.enviar({ tipo: 'oferta', de: 'emisor', para: id, sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
    // Ante poco ancho de banda se pierden cuadros, no resolución.
    const p = transceptor.sender.getParameters();
    p.degradationPreference = 'maintain-resolution';
    (p.encodings || []).forEach((enc) => {
      enc.maxBitrate = bitrate;
      enc.maxFramerate = fps;
    });
    await transceptor.sender.setParameters(p).catch((err) => console.warn(err));
    // A los 15 s sin conectar, la señal llegó pero la conexión directa no (el 'failed' de ICE tarda más).
    setTimeout(() => {
      if (teles.get(id) === pc && !conectada(pc)) alFallar();
    }, 15000);
  }

  const canal = abrirCanal(secreto, (m) => {
    if (m.para !== 'emisor' || typeof m.de !== 'string') return;
    const pc = teles.get(m.de);
    if (m.tipo === 'hola') ofrecer(m.de).catch((err) => console.warn(err));
    else if (m.tipo === 'respuesta' && pc) pc.setRemoteDescription(m.sdp).catch((err) => console.warn(err));
    else if (m.tipo === 'ice' && pc) pc.addIceCandidate(m.candidato).catch(() => {});
  }, () => canal.enviar({ tipo: 'emisor-listo', de: 'emisor' }));

  return {
    cerrar() {
      canal.cerrar();
      Array.from(teles.keys()).forEach(cerrar);
    },
  };
}

/**
 * Reproduce en `video` la transmisión del canal `secreto`. Pide video hasta que llega y, si se corta, lo vuelve a pedir.
 * `alEstado` recibe 'esperando', 'conectando', 'bloqueada', 'conectado' o 'reconectando'.
 */
export function recibir(video, secreto, alEstado) {
  const yo = nuevoSecreto().slice(0, 12);
  const avisar = alEstado || (() => {});
  let pc = null, pedido = 0, caida = null, trabada = null, remotoListo = false, bloqueada = false;
  let iceEnEspera = [];

  const conectadaAhora = () => pc !== null && conectada(pc);

  function pedir() {
    pedido = Date.now();
    canal.enviar({ tipo: 'hola', de: yo, para: 'emisor' });
  }

  async function atender(sdp) {
    pedido = Date.now();
    if (pc) pc.close();
    const actual = pc = new RTCPeerConnection({ iceServers: ICE });
    remotoListo = false;
    iceEnEspera = [];
    actual.ontrack = (e) => {
      video.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      const reproduccion = video.play();
      if (reproduccion && reproduccion.catch) reproduccion.catch(() => {});
    };
    actual.onicecandidate = (e) => {
      if (e.candidate) canal.enviar({ tipo: 'ice', de: yo, para: 'emisor', candidato: e.candidate.toJSON() });
    };
    actual.oniceconnectionstatechange = () => {
      if (actual !== pc) return;
      const s = actual.iceConnectionState;
      clearTimeout(caida);
      if (s === 'connected' || s === 'completed') {
        clearTimeout(trabada);
        bloqueada = false;
        avisar('conectado');
      } else if (s === 'disconnected') {
        caida = setTimeout(() => {
          if (!conectadaAhora()) { avisar('reconectando'); pedir(); }
        }, 4000);
      } else if (s === 'failed') {
        avisar('reconectando');
        pedir();
      }
    };
    await actual.setRemoteDescription(sdp);
    // Los candidatos que llegaron antes de la oferta completa se agregan recién ahora (los Chromium viejos
    // rechazan un candidato sin descripción remota).
    remotoListo = true;
    iceEnEspera.forEach((c) => actual.addIceCandidate(c).catch(() => {}));
    iceEnEspera = [];
    const respuesta = await actual.createAnswer();
    await actual.setLocalDescription(respuesta);
    canal.enviar({ tipo: 'respuesta', de: yo, para: 'emisor', sdp: { type: 'answer', sdp: actual.localDescription.sdp } });
    if (!bloqueada) avisar('conectando');  // el aviso de bloqueo queda fijo hasta que conecte
    // Si en 15 s no conecta, la señal llegó pero la conexión directa está bloqueada: se avisa y se sigue probando.
    clearTimeout(trabada);
    trabada = setTimeout(() => {
      if (actual === pc && !conectadaAhora()) {
        bloqueada = true;
        avisar('bloqueada');
      }
    }, 15000);
  }

  const canal = abrirCanal(secreto, (m) => {
    if (m.tipo === 'emisor-listo') {
      if (!conectadaAhora()) pedir();  // el emisor recién se abrió
      return;
    }
    if (m.para !== yo || m.de !== 'emisor') return;
    if (m.tipo === 'oferta') {
      atender(m.sdp).catch((err) => { console.warn(err); pedido = 0; });
    } else if (m.tipo === 'ice' && pc) {
      if (remotoListo) pc.addIceCandidate(m.candidato).catch(() => {});
      else iceEnEspera.push(m.candidato);
    }
  }, pedir);

  // Mientras no haya video insiste. Si hay un intento en curso le da 20 s: reintentar antes lo reinicia en el
  // emisor, y así ningún intento llega a conectar ni a fallar.
  const insistir = setInterval(() => {
    const negociando = pc !== null && (pc.iceConnectionState === 'new' || pc.iceConnectionState === 'checking');
    if (!conectadaAhora() && Date.now() - pedido > (negociando ? 20000 : 6000)) pedir();
  }, 2000);

  avisar('esperando');
  return {
    cerrar() {
      clearInterval(insistir);
      canal.cerrar();
      if (pc) pc.close();
    },
  };
}

/**
 * Tele sin emparejar: escucha en el canal de su código de 3 cifras hasta que un emisor le mande el secreto largo.
 */
export function esperarEmparejamiento(codigo, alEmparejar) {
  let hecho = false;
  const canal = abrirCanal('par-' + codigo, (m) => {
    if (hecho || m.tipo !== 'emparejar' || !secretoValido(m.secreto)) return;
    hecho = true;
    canal.enviar({ tipo: 'emparejada' });
    setTimeout(() => canal.cerrar(), 1500);
    alEmparejar(m.secreto);
  }, () => {});
  return { cerrar: () => canal.cerrar() };
}

/** Emisor: le manda `secreto` a la tele que muestra `codigo` hasta que confirme; se rinde a los 2 minutos. */
export function emparejar(codigo, secreto, alTerminar) {
  let listo = false;
  const mandar = () => canal.enviar({ tipo: 'emparejar', secreto });
  const canal = abrirCanal('par-' + codigo, (m) => {
    if (m.tipo !== 'emparejada' || listo) return;
    listo = true;
    clearInterval(repetir);
    setTimeout(() => canal.cerrar(), 1500);
    alTerminar(true);
  }, mandar);
  const repetir = setInterval(mandar, 2000);
  setTimeout(() => {
    if (listo) return;
    clearInterval(repetir);
    canal.cerrar();
    alTerminar(false);
  }, 120000);
}
