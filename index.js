const express = require('express');
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

const CATEGORIES = [
  'sueldo','nafta','delivery','asado','alcohol','truco',
  'cigarrillos','seguro_auto','monotributo','padel','fiestas','celular'
];

const CAT_LABELS = {
  sueldo:'Sueldo', nafta:'Nafta', delivery:'Delivery', asado:'Asado',
  alcohol:'Alcohol', truco:'Truco', cigarrillos:'Cigarrillos',
  seguro_auto:'Seguro del auto', monotributo:'Monotributo',
  padel:'Padel', fiestas:'Fiestas', celular:'Celular'
};

// Guardado en memoria (Railway lo mantiene mientras corre)
let movimientos = [];

async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
  return res.json();
}

async function interpretMessage(text) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Analizá este mensaje y extraé la información de un gasto o ingreso.
Categorías disponibles: ${CATEGORIES.join(', ')}
Monedas posibles: ARS o USD (si no se menciona, usar ARS)

Mensaje: "${text}"

Respondé SOLO con JSON, sin texto extra, con este formato:
{"tipo":"gasto","catId":"nafta","amount":5000,"currency":"ARS","desc":"descripcion opcional"}

Si es ingreso, tipo="ingreso". Si no podés interpretar, responde: {"error":"no entendido"}`
      }]
    })
  });
  const data = await res.json();
  console.log('API response:', JSON.stringify(data));
  if (!data.content || !data.content[0]) {
    console.error('API error:', JSON.stringify(data));
    throw new Error('API sin respuesta válida');
  }
  const content = data.content[0].text.trim();
  const cleaned = content.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function getResumen(month, year) {
  const key = `${year}-${String(month+1).padStart(2,'0')}`;
  const movs = movimientos.filter(m => m.date.startsWith(key));
  const ingresos = movs.filter(m => m.tipo==='ingreso').reduce((s,m) => s+m.amount, 0);
  const gastos = movs.filter(m => m.tipo==='gasto').reduce((s,m) => s+m.amount, 0);
  const balance = ingresos - gastos;
  
  const porCat = {};
  movs.filter(m => m.tipo==='gasto').forEach(m => {
    if (!porCat[m.catId]) porCat[m.catId] = 0;
    porCat[m.catId] += m.amount;
  });

  let catLines = Object.entries(porCat)
    .sort((a,b) => b[1]-a[1])
    .map(([id, amt]) => `  • ${CAT_LABELS[id]||id}: $${Math.round(amt).toLocaleString('es-AR')}`)
    .join('\n');

  return `📊 *Resumen del mes*\n\n` +
    `✅ Ingresos: $${Math.round(ingresos).toLocaleString('es-AR')}\n` +
    `❌ Gastos: $${Math.round(gastos).toLocaleString('es-AR')}\n` +
    `${balance>=0?'💰':'⚠️'} Balance: $${Math.round(Math.abs(balance)).toLocaleString('es-AR')} ${balance>=0?'a favor':'en rojo'}\n` +
    (catLines ? `\n*Por categoría:*\n${catLines}` : '');
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Comandos
  if (text === '/start' || text === '/ayuda') {
    return sendTelegram(chatId,
      `👋 *Hola! Soy tu bot de gastos.*\n\n` +
      `Mandame mensajes como:\n` +
      `• "gasté 5000 en nafta"\n` +
      `• "cobré el sueldo 200000"\n` +
      `• "delivery 3500 dólares"\n` +
      `• "500 usd de monotributo"\n\n` +
      `*Comandos:*\n` +
      `/resumen - ver resumen del mes\n` +
      `/ultimos - últimos 5 movimientos\n` +
      `/ayuda - ver esta ayuda`
    );
  }

  if (text === '/resumen') {
    const now = new Date();
    return sendTelegram(chatId, getResumen(now.getMonth(), now.getFullYear()));
  }

  if (text === '/ultimos') {
    const ultimos = movimientos.slice(-5).reverse();
    if (!ultimos.length) return sendTelegram(chatId, 'No hay movimientos registrados aún.');
    const lines = ultimos.map(m =>
      `${m.tipo==='ingreso'?'✅':'❌'} ${CAT_LABELS[m.catId]||m.catId}: ${m.currency} $${Math.round(m.amount).toLocaleString('es-AR')}${m.desc?' ('+m.desc+')':''}`
    ).join('\n');
    return sendTelegram(chatId, `*Últimos movimientos:*\n${lines}`);
  }

  // Interpretar con IA
  try {
    const result = await interpretMessage(text);
    if (result.error) {
      return sendTelegram(chatId,
        `No entendí el mensaje 🤔\n\nProbá con algo como:\n"gasté 5000 en nafta"\n"cobré sueldo 150000"`
      );
    }
    const mov = {
      id: Date.now(),
      tipo: result.tipo,
      catId: result.catId,
      amount: result.amount,
      currency: result.currency || 'ARS',
      desc: result.desc || '',
      date: new Date().toISOString().split('T')[0]
    };
    movimientos.push(mov);
    const emoji = mov.tipo === 'ingreso' ? '✅' : '❌';
    const catName = CAT_LABELS[mov.catId] || mov.catId;
    await sendTelegram(chatId,
      `${emoji} *Registrado!*\n\n` +
      `📂 Categoría: ${catName}\n` +
      `💵 Monto: ${mov.currency} $${Math.round(mov.amount).toLocaleString('es-AR')}\n` +
      `📅 Fecha: ${mov.date}` +
      (mov.desc ? `\n📝 Nota: ${mov.desc}` : '')
    );
  } catch(e) {
    console.error(e);
    sendTelegram(chatId, 'Hubo un error procesando tu mensaje. Intentá de nuevo.');
  }
});

app.get('/', (req, res) => res.send('Bot de gastos funcionando ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
