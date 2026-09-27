// Actualiza la lista de temas de actualidad que la moderación tiene que evitar, a partir de los titulares de medios
// argentinos. La llama una vez por día pg_cron (supabase/moderacion.sql) con el secreto CRON_SECRET.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { PROVEEDOR, pedirJson } from '../_shared/ia.ts';

// Corre una vez por día: conviene el modelo más capaz, no el más rápido.
const MODELO = Deno.env.get('MODELO_TEMAS') ?? (PROVEEDOR === 'openai' ? 'gpt-4.1' : 'claude-opus-5');
const DIAS_VIGENCIA = 30;  // un tema que no vuelve a aparecer en las noticias sale de la lista después de esto

const FUENTES = [
  'https://www.clarin.com/rss/lo-ultimo/',
  'https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml',
  'https://www.infobae.com/arc/outboundfeeds/rss/',
  'https://www.perfil.com/feed',
  'https://www.ambito.com/rss/pages/home.xml',
  'https://www.lapoliticaonline.com/files/rss/ultimasnoticias.xml',
];

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const ENTIDADES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
const limpiar = (t: string) => t.replace(/&(amp|quot|#39|apos|lt|gt);/g, (e) => ENTIDADES[e]).replace(/\s+/g, ' ').trim();

async function titulares(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Acuarella)' }, signal: AbortSignal.timeout(15_000) });
    const xml = await res.text();
    return [...xml.matchAll(/<item[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => limpiar(m[1])).filter(Boolean).slice(0, 100);
  } catch (err) {
    console.warn('No se pudo leer', url, String(err));
    return [];
  }
}

const ESQUEMA = {
  type: 'object',
  properties: {
    temas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tema: { type: 'string', description: 'Nombre de la persona, caso o tema, como lo escribiría alguien a mano' },
          detalle: { type: 'string', description: 'Por qué es sensible hoy, en pocas palabras' },
        },
        required: ['tema', 'detalle'],
        additionalProperties: false,
      },
    },
  },
  required: ['temas'],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('No autorizado', { status: 401 });
  }
  const lista = [...new Set((await Promise.all(FUENTES.map(titulares))).flat())].slice(0, 500);
  if (!lista.length) return new Response(JSON.stringify({ error: 'No se pudo leer ninguna fuente' }), { status: 502 });

  const respuesta = await pedirJson<{ temas: { tema: string; detalle: string }[] }>({
    modelo: MODELO,
    maxTokens: 16000,
    sistema: `Armás la lista de temas que no pueden aparecer en dibujos de visitantes que se muestran en una
pantalla pública de una universidad, con criterio de oficina corporativa. A partir de los titulares del día, listá
las personas, casos y temas de la actualidad argentina e internacional que serían inapropiados si alguien los
escribiera en un dibujo: políticos y funcionarios, partidos y consignas, causas judiciales, crímenes, muertes y
tragedias resonantes, escándalos, figuras religiosas y personajes mediáticos polémicos. Escribí cada tema como lo
pondría alguien a mano (apellido o apodo conocido). No incluyas temas neutros como el clima, la economía en general,
deportes sin polémica ni espectáculos inofensivos. Entre 20 y 80 temas.`,
    texto: `Titulares de hoy:\n${lista.map((t) => `- ${t}`).join('\n')}`,
    nombre: 'temas',
    esquema: ESQUEMA,
  });
  if (!respuesta) return new Response(JSON.stringify({ error: 'El modelo se negó a responder' }), { status: 502 });
  const { temas } = respuesta;

  const ahora = new Date().toISOString();
  const filas = temas.map((t) => ({ tema: t.tema.trim(), detalle: t.detalle.trim(), fuente: 'noticias', visto: ahora }))
    .filter((t) => t.tema);
  const { error } = await db.from('temas_sensibles').upsert(filas, { onConflict: 'tema' });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const vencimiento = new Date(Date.now() - DIAS_VIGENCIA * 86_400_000).toISOString();
  await db.from('temas_sensibles').delete().eq('fuente', 'noticias').lt('visto', vencimiento);

  const resultado = { titulares: lista.length, temas: filas.length };
  console.log(JSON.stringify(resultado));
  return new Response(JSON.stringify(resultado), { headers: { 'Content-Type': 'application/json' } });
});
