// Pedirle una respuesta JSON a la IA, con OpenAI o con Anthropic.
// El proveedor sale de PROVEEDOR_IA ('openai' | 'anthropic'); si no está, de la clave que haya cargada
// (OPENAI_API_KEY o ANTHROPIC_API_KEY en los secretos de las funciones).

import OpenAI from 'npm:openai';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { encodeBase64 } from 'jsr:@std/encoding/base64';

export const PROVEEDOR: 'openai' | 'anthropic' = (Deno.env.get('PROVEEDOR_IA') as 'openai' | 'anthropic' | undefined) ??
  (Deno.env.get('OPENAI_API_KEY') ? 'openai' : 'anthropic');

export type Pedido = {
  modelo: string;
  sistema: string;           // criterio fijo
  contexto?: string;         // datos que cambian (temas del día, personas); va después del criterio
  imagenPng?: Uint8Array;
  texto: string;
  nombre: string;            // nombre del esquema (OpenAI lo pide)
  esquema: Record<string, unknown>;
  maxTokens?: number;
};

/** El JSON que pide `esquema`, o null si el modelo se negó a responder. */
export async function pedirJson<T>(p: Pedido): Promise<T | null> {
  return PROVEEDOR === 'openai' ? conOpenAI<T>(p) : conAnthropic<T>(p);
}

async function conOpenAI<T>(p: Pedido): Promise<T | null> {
  const openai = new OpenAI();  // OPENAI_API_KEY
  const contenido: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (p.imagenPng) {
    contenido.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${encodeBase64(p.imagenPng)}`, detail: 'high' } });
  }
  contenido.push({ type: 'text', text: p.texto });
  const respuesta = await openai.chat.completions.create({
    model: p.modelo,
    max_completion_tokens: p.maxTokens ?? 1024,
    messages: [
      // Criterio primero y datos variables después: OpenAI reusa el prefijo repetido entre pedidos.
      { role: 'system', content: p.contexto ? `${p.sistema}\n\n${p.contexto}` : p.sistema },
      { role: 'user', content: contenido },
    ],
    response_format: { type: 'json_schema', json_schema: { name: p.nombre, schema: p.esquema, strict: true } },
  });
  const mensaje = respuesta.choices[0]?.message;
  if (!mensaje || mensaje.refusal) return null;
  if (!mensaje.content) throw new Error(`Respuesta vacía (${respuesta.choices[0]?.finish_reason})`);
  return JSON.parse(mensaje.content) as T;
}

async function conAnthropic<T>(p: Pedido): Promise<T | null> {
  const anthropic = new Anthropic();  // ANTHROPIC_API_KEY
  const sistema: Anthropic.TextBlockParam[] = [{ type: 'text', text: p.sistema }];
  if (p.contexto) sistema.push({ type: 'text', text: p.contexto, cache_control: { type: 'ephemeral' } });
  const contenido: Anthropic.ContentBlockParam[] = [];
  if (p.imagenPng) {
    contenido.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: encodeBase64(p.imagenPng) } });
  }
  contenido.push({ type: 'text', text: p.texto });
  const respuesta = await anthropic.messages.create({
    model: p.modelo,
    max_tokens: p.maxTokens ?? 1024,
    system: sistema,
    messages: [{ role: 'user', content: contenido }],
    output_config: { format: { type: 'json_schema', schema: p.esquema } },
  });
  if (respuesta.stop_reason === 'refusal') return null;
  const bloque = respuesta.content.find((b) => b.type === 'text');
  if (!bloque || bloque.type !== 'text') throw new Error(`Respuesta sin texto (${respuesta.stop_reason})`);
  return JSON.parse(bloque.text) as T;
}
