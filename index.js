const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

// Inicializa a IA da Google
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Lista na memória do servidor para guardar quem escolheu falar com humano
const clientesEmAtendimentoHumano = new Set();

// Carrega o estoque do arquivo separado (produtos.json)
let mapProdutos = "Nenhum produto cadastrado.";
try {
    if (fs.existsSync('./produtos.json')) {
        mapProdutos = fs.readFileSync('./produtos.json', 'utf-8');
    }
} catch (erro) {
    console.error("Erro ao ler o arquivo produtos.json:", erro);
}

const systemInstruction = `
Você é a Ster, uma consultora de vendas digital extremamente simpática da Ducarmo Exclusive. Seu objetivo é conduzir as clientes com carinho através do nosso funil de vendas.

A REGRA DE OURO DA DUCARMO (Varejo vs. Atacado):
- Varejo: Menos de R$ 150,00.
- Atacado: A partir de R$ 150,00 (ganha desconto de fábrica em todas as peças!).

REGRA DE ATENDIMENTO HUMANO / PESSOAL:
- Você deve SEMPRE deixar a cliente livre. Se ela perguntar por "atendimento humano", "falar com pessoa", "atendente", ou se você notar que ela quer fechar o pedido com o dono, você deve aceitar com muita simpatia.
- Quando a cliente solicitar atendimento pessoal, despeça-se com carinho e adicione obrigatoriamente a tag [ATENDIMENTO_HUMANO] exatamente no final da sua resposta. 
- Exemplo de resposta para quando pedirem humano: "Claro, minha flor! Vou te passar agora mesmo para a nossa equipe pessoal te ajudar, tá bom? Só um momentinho! 💕 [ATENDIMENTO_HUMANO]"

O FUNIL DE ATENDIMENTO DO WHATSAPP:
1. BOAS-VINDAS: Diga que compras acima de R$ 150 ganham preço de atacado de fábrica!
2. CONSULTORIA: Pergunte o tamanho (P, M, G, GG, EX) e o que ela procura (Lycra, Cetinete, Antialérgico ou Renda).
3. APRESENTAÇÃO: Mostre os modelos e valores correspondentes.
4. FECHO DO PEDIDO: Some os valores. Ofereça mais peças se estiver perto de bater R$ 150 para liberar o atacado.
5. ENCAMINHAMENTO: Quando ela aceitar fechar ou quiser pagar, mande a mensagem de transição e inclua a tag [ATENDIMENTO_HUMANO].

Este é o catálogo oficial de produtos da Ducarmo Exclusive:
${mapProdutos}
`;

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    // CONSTANTE DA NOVA FUNÇÃO: CONEXÃO VIA NÚMERO (PAIRING CODE)
    if (!sock.authState.creds.registered && process.env.NUMERO_WHATSAPP) {
        setTimeout(async () => {
            try {
                // Remove espaços e traços do número configurado
                const numeroLimpo = process.env.NUMERO_WHATSAPP.replace(/\D/g, '');
                const codigo = await sock.requestPairingCode(numeroLimpo);
                console.log(`\n=================================================`);
                console.log(`🔑 SEU CÓDIGO DE PAREAMENTO NO CELULAR: ${codigo}`);
                console.log(`=================================================\n`);
            } catch (errCode) {
                console.error("Erro ao gerar código de pareamento por número:", errCode);
            }
        }, 6000); // Aguarda o carregamento inicial do servidor
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Se configurou o número, avisa no log e pula o desenho do QR code
            if (process.env.NUMERO_WHATSAPP) {
                console.log('[Aviso] Gerando código numérico... Ignorando QR Code visual.');
            } else {
                console.log('\n▼ ESCANEIE O QR CODE ABAIXO PARA CONECTAR A STER ▼\n');
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'close') {
            const deveReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (deveReiniciar) conectarWhatsApp();
        } else if (connection === 'open') {
            console.log('\n🚀 PROJETO CONECTADO! A Ster está ativa e operando na Ducarmo Exclusive!\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key.remoteJid;
            if (jid.endsWith('@g.us')) continue; // Ignora grupos

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            // BONUS TRACK: Comando para o dono da loja reativar o bot na conversa
            if (msg.key.fromMe && textoCliente === '/bot') {
                clientesEmAtendimentoHumano.delete(jid);
                await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Voltei a cuidar do atendimento automático desta conversa lindeza." });
                continue;
            }

            // Se o cliente escolheu atendimento humano, a Ster fica em silêncio absoluto nessa conversa
            if (clientesEmAtendimentoHumano.has(jid)) continue;

            if (msg.key.fromMe) continue;
            if (!textoCliente) continue;

            console.log(`[Conversa] de ${jid}: ${textoCliente}`);

            try {
                const respostaGemini = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: textoCliente,
                    config: { systemInstruction: systemInstruction }
                });

                let textoFinal = respostaGemini.text;

                // NOVA FUNÇÃO: Intercepta se o cliente pediu atendimento pessoal
                if (textoFinal.includes('[ATENDIMENTO_HUMANO]')) {
                    clientesEmAtendimentoHumano.add(jid); // Bloqueia o robô para essa pessoa
                    textoFinal = textoFinal.replace('[ATENDIMENTO_HUMANO]', '').trim(); // Remove a tag do texto
                    await sock.sendMessage(jid, { text: textoFinal });
                    console.log(`[Status] Chat ${jid} transferido para o Atendimento Humano.`);
                    continue;
                }

                await sock.sendMessage(jid, { text: textoFinal });
                
            } catch (erro) {
                console.error("Erro na comunicação com o Gemini:", erro);
            }
        }
    });
}

conectarWhatsApp();
