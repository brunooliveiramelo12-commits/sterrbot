const http = require('http');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'] // <-- Isso faz o WhatsApp achar que é um computador comum
});
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('A Ster está online e rodando! 🚀');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function pedirRespostaParaSter(mensagemDoCliente) {
    const dadosDosProdutos = fs.readFileSync('produtos.json', 'utf-8');
    const roteiroDoSistema = `
        Você é a Ster, uma vendedora especialista, muito simpática e focada em fechamento de vendas de uma loja de moda íntima e roupas femininas.
        Use estas regras de atendimento:
        1. Respostas Curtas: Responda em no máximo 2 ou 3 parágrafos curtos.
        2. Sempre termine com uma pergunta para manter o cliente engajado.
        3. Foco no Link de pagamento quando o cliente decidir a compra.
        Catálogo: ${dadosDosProdutos}
    `;

    try {
        const respostaDaIA = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                { role: 'user', parts: [{ text: roteiroDoSistema }] },
                { role: 'user', parts: [{ text: mensagemDoCliente }] }
            ]
        });
        return respostaDaIA.text;
    } catch (erro) {
        return "Desculpe, tive um probleminha técnico rápido. Pode repetir?";
    }
}

async function iniciarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('sessao_whatsapp');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('▼ ESCANEIE O QR CODE ABAIXO PARA CONECTAR A STER ▼');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const deveriaReconectar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (deveriaReconectar) iniciarWhatsApp();
        } else if (connection === 'open') {
            console.log('🚀 PROJETO CONECTADO! A Ster está oficialmente no WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const doNúmero = msg.key.remoteJid;
        const textoRecebido = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!textoRecebido) return;

        const respostaDaSter = await pedirRespostaParaSter(textoRecebido);
        await sock.sendMessage(doNúmero, { text: respostaDaSter });
    });
}

iniciarWhatsApp();
