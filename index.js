const express = require('express');
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

const CAT_LABELS = {
  sueldo:'Sueldo', nafta:'Nafta', delivery:'Delivery', asado:'Asado',
  alcohol:'Alcohol', truco:'Truco', cigarrillos:'Cigarrillos',
  seguro_auto:'Seguro del auto', monotributo:'Monotributo',
  padel:'Padel', fiestas:'Fiestas', celular:'Celular'
};

let movimientos = [];

async function sendTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch(e) {
    console.error('Error sending telegram:', e.message);
  }
}

async function interpretMessage(text) {
  const categories = Object.keys(CAT_LABELS).join(', ');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Extraé info de este mensaje de gasto/ingreso. Categorías: ${categories}. Moneda default ARS.
Mensaje: "${text}"
Respondé SOLO JSON sin markdown: {"tipo":"gasto","catId":"nafta","amount":5000,"currency":"ARS","desc":""}
Si no entendés: {"error":"no entendido"}`
      }]
    })
  });

  const raw = await res.text();
  console.log('Anthropic raw:', raw);
  
  const data = JSON.parse(raw);
  
  if (!data.content || !data.content[0] || !data.content[0].text) {
    console.error('No content in response:', raw);
    return { error: 'sin respuesta' };
  }
  
  const txt = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  console.log('Parsed text:', txt);
  return JSON.parse(txt);
}

function getResumen() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const movs = movimientos.filter(m => m.date.startsWith(key));
  const ingresos = movs.filter(m => m.tipo==='ingreso').reduce((s,m) => s+m.amount, 0);
  const gastos = movs.filter(m => m.tipo==='gasto').reduce((s,m) => s+m.amount, 0);
  const balance = ingresos - gastos;

  const porCat = {};
  movs.filter(m => m.tipo==='gasto').forEach(m => {
    porCat[m.catId] = (porCat[m.catId] || 0) + m.amount;
  });

  let catLines = Object.entries(porCat)
    .sort((a,b) => b[1]-a[1])
    .map(([id, amt]) => `  • ${CAT_LABELS[id]||id}: $${Math.round(amt).toLocaleString('es-AR')}`)
    .join('\n');

  return `📊 *Resumen del mes*\n\n` +
    `✅ Ingresos: $${Math.round(ingresos).toLocaleString('es-AR')}\n` +
    `❌ Gastos: $${Math.round(gastos).toLocaleString('es-AR')}\n` +
    `${balance>=0?'💰':'⚠️'} Balance: $${Math.round(Math.abs(balance)).toLocaleString('es-AR')} ${balance>=0?'a favor':'en rojo'}` +
    (catLines ? `\n\n*Por categoría:*\n${catLines}` : '');
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    console.log(`Mensaje de ${chatId}: ${text}`);

    if (text === '/start' || text === '/ayuda') {
      return sendTelegram(chatId,
        `👋 *Hola! Soy tu bot de gastos.*\n\n` +
        `Mandame mensajes como:\n` +
        `• "gasté 5000 en nafta"\n` +
        `• "cobré el sueldo 200000"\n` +
        `• "delivery 3500"\n\n` +
        `*Comandos:*\n/resumen\n/ultimos\n/ayuda`
      );
    }

    if (text === '/resumen') {
      return sendTelegram(chatId, getResumen());
    }

    if (text === '/ultimos') {
      const ultimos = movimientos.slice(-5).reverse();
      if (!ultimos.length) return sendTelegram(chatId, 'No hay movimientos aún.');
      const lines = ultimos.map(m =>
        `${m.tipo==='ingreso'?'✅':'❌'} ${CAT_LABELS[m.catId]||m.catId}: ${m.currency} $${Math.round(m.amount).toLocaleString('es-AR')}${m.desc?' ('+m.desc+')':''}`
      ).join('\n');
      return sendTelegram(chatId, `*Últimos movimientos:*\n${lines}`);
    }

    const result = await interpretMessage(text);

    if (result.error) {
      return sendTelegram(chatId,
        `No entendí el mensaje 🤔\n\nProbá con:\n"gasté 5000 en nafta"\n"cobré sueldo 150000"`
      );
    }

    const mov = {
      id: Date.now(),
      tipo: result.tipo || 'gasto',
      catId: result.catId || 'celular',
      amount: parseFloat(result.amount) || 0,
      currency: result.currency || 'ARS',
      desc: result.desc || '',
      date: new Date().toISOString().split('T')[0]
    };
    movimientos.push(mov);

    const emoji = mov.tipo === 'ingreso' ? '✅' : '❌';
    const catName = CAT_LABELS[mov.catId] || mov.catId;
    await sendTelegram(chatId,
      `${emoji} *Registrado!*\n\n` +
      `📂 ${catName}\n` +
      `💵 ${mov.currency} $${Math.round(mov.amount).toLocaleString('es-AR')}\n` +
      `📅 ${mov.date}` +
      (mov.desc ? `\n📝 ${mov.desc}` : '')
    );

  } catch(e) {
    console.error('Error en webhook:', e.message, e.stack);
  }
});

app.get('/', (req, res) => res.send('Bot de gastos OK ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
