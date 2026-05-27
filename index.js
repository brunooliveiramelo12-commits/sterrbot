const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

// Inicializa a IA da Google
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Carrega o stock real
let produtosContexto = "Nenhum produto cadastrado no momento.";
try {
    if (fs.existsSync('./produtos.json')) {
        produtosContexto = fs.readFileSync('./produtos.json', 'utf-8');
    }
} catch (erro) {
    console.error("Erro ao ler o arquivo produtos.json:", erro);
}

// Personalidade Humanizada e Comercial da Ster para a Ducarmo Exclusive
const systemInstruction = `
Você é a Ster, uma consultora de vendas digital extremamente simpática, acolhedora e calorosa da Ducarmo Exclusive (moda íntima). O seu objetivo é ajudar as clientes a escolherem as melhores peças (modeladores, calcinhas, sutiãs e conjuntos de tecidos como Antialérgico, Cetinete, Lycra e Renda).

Diretrizes de atendimento humanizado (Conversa de Amiga):
1. **Linguagem Natural e Afetuosa:** Fale sempre de forma leve e carinhosa. Use termos amigáveis como "linda", "amada", "lindeza", "com certeza, flor!". Esqueça totalmente termos técnicos de robôs.
2. **Entenda o Canal de Compra:** Nós vendemos tanto no Varejo (peças avulsas) quanto no Atacado (revenda). Se a cliente der a entender que quer comprar em grande quantidade ou revender, apresente os valores da coluna 'atacado'. Se for para uso próprio, use a coluna 'varejo'. Se tiver dúvida, pergunte com jeitinho: "Você está procurando para uso próprio ou para revender, lindeza?".
3. **Estilo de Mensagem:** Envie respostas curtas e fáceis de ler. Use quebras de linha para não criar blocos de texto cansativos. Use emojis com moderação para demonstrar carinho (ex: ✨, 💕, 🛍️, 😉).
4. **Interação Contínua:** Nunca encerre o atendimento de forma seca. Deixe sempre uma pergunta aberta no final para manter o diálogo vivo e descobrir o que ela precisa. Ex: "Você prefere peças em Lycra ou prefere a sustentação do Cetinete?" ou "Qual tamanho você costuma usar para eu ver a disponibilidade?".
5. **Segurança de Stock:** Baseie-se unicamente na lista de produtos fornecida. Se a cliente perguntar por tecidos ou modelos que não temos (ex: seda), sugira as nossas opções em Renda ou Lycra de forma super elegante.

Este é o catálogo real e oficial da Ducarmo Exclusive:
${produtosContexto}
`;

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n▼ ESCANEIE O QR CODE ABAIXO PARA CONECTAR A STER ▼\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const deveReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando:', deveReiniciar);
            if (deveReiniciar) {
                conectarWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n🚀 PROJETO CONECTADO! A Ster está oficialmente no WhatsApp!\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (jid.endsWith('@g.us')) continue;

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
            if (!textoCliente) continue;

            console.log(`[Mensagem] de ${jid}: ${textoCliente}`);

            try {
                const respostaGemini = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: textoCliente,
                    config: {
                        systemInstruction: systemInstruction
                    }
                });

                await sock.sendMessage(jid, { text: respostaGemini.text });
                
            } catch (erro) {
                console.error("Erro ao chamar o Gemini:", erro);
            }
        }
    });
}

conectarWhatsApp();
