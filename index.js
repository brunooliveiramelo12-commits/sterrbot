const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

// Inicializa a IA da Google
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Configurações de Produção da Loja
const NUMERO_WHATSAPP = '5588992270058';
const clientesEmAtendimentoHumano = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
Você é a Ster, uma consultora de vendas digital extremamente simpática, calorosa e dedicada da Ducarmo Exclusive (moda íntima). Seu objetivo é conduzir as clientes com carinho através do nosso funil de vendas.

A REGRA DE OURO DA DUCARMO (Varejo vs. Atacado):
- Varejo: Menos de R$ 150,00.
- Atacado: A partir de R$ 150,00 (ganha desconto de fábrica em todas as peças!).
- Estratégia: Se o carrinho da cliente estiver perto de R$ 150, incentive-a a levar mais um item para liberar o preço de atacado.

REGRA DE ATENDIMENTO HUMANO / PESSOAL:
- Se a cliente pedir para falar com um atendente, humano, ou se demonstrar que quer fechar o pagamento, despeça-se com carinho e adicione a tag [ATENDIMENTO_HUMANO] no final do texto.
- Exemplo: "Com certeza, lindeza! Vou chamar o pessoal do financeiro agora. Só um minutinho! 💕 [ATENDIMENTO_HUMANO]"

O FUNIL DE ATENDIMENTO DO WHATSAPP:
1. BOAS-VINDAS: Receba com alegria e cite o gatilho do Atacado a partir de R$ 150.
2. CONSULTORIA: Descubra o tamanho (P, M, G, GG, EX) e a preferência de tecido (Lycra, Cetinete, Antialérgico ou Renda).
3. APRESENTAÇÃO: Mostre as opções e valores do catálogo.
4. FECHO DO PEDIDO: Some tudo e aplique a regra de preço correta.
5. ENCAMINHAMENTO: Transição para o humano com a tag secreta.

Este é o catálogo oficial de produtos da Ducarmo Exclusive:
${mapProdutos}
`;

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ducarmo Exclusive', 'Chrome', '1.0.0']
    });

    // Conexão via Código de Pareamento por Número
    if (!sock.authState.creds.registered && NUMERO_WHATSAPP) {
        setTimeout(async () => {
            try {
                const numeroLimpo = NUMERO_WHATSAPP.replace(/\D/g, '');
                const codigo = await sock.requestPairingCode(numeroLimpo);
                console.log(`\n=================================================`);
                console.log(`🔑 SEU CÓDIGO DE PAREAMENTO NO CELULAR: ${codigo}`);
                console.log(`=================================================\n`);
            } catch (errCode) {
                console.error("Erro ao gerar código de pareamento:", errCode);
            }
        }, 6000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !NUMERO_WHATSAPP) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const codigoStatus = lastDisconnect?.error?.output?.statusCode;
            const deveReiniciar = codigoStatus !== DisconnectReason.loggedOut;
            console.log(`[Conexão] Fechada (Status: ${codigoStatus}). Reiniciando: ${deveReiniciar}`);
            if (deveReiniciar) conectarWhatsApp();
        } else if (connection === 'open') {
            console.log('\n=================================================');
            console.log('🚀 DUCARMO EXCLUSIVE - STER EM MODO DE USO 24H!');
            console.log('=================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue; // Proteção contra grupos

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            // Comando do Dono para reativar o Bot
            if (msg.key.fromMe && textoCliente === '/bot') {
                clientesEmAtendimentoHumano.delete(jid);
                await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Voltei a cuidar do atendimento automático desta conversa lindeza." });
                continue;
            }

            if (clientesEmAtendimentoHumano.has(jid)) continue;
            if (msg.key.fromMe) continue;
            if (!textoCliente) continue;

            // PROTEÇÃO DE PRODUÇÃO: Ignora mensagens antigas recebidas durante quedas ou reinicializações
            const timestampMensagem = msg.messageTimestamp;
            const timestampAgora = Math.floor(Date.now() / 1000);
            if (timestampAgora - timestampMensagem > 60) {
                continue; 
            }

            console.log(`[Mensagem Real] de ${jid}: ${textoCliente}`);

            try {
                // EFEITO HUMANIZADO: Ativa o "Digitando..." no celular do cliente
                await sock.sendPresenceUpdate('composing', jid);
                await delay(2500); // Aguarda 2.5 segundos simulando digitação humana

                const respostaGemini = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: textoCliente,
                    config: { systemInstruction: systemInstruction }
                });

                let textoFinal = respostaGemini.text;
                await sock.sendPresenceUpdate('paused', jid);

                // Interceptação de Atendimento Humano
                if (textoFinal.includes('[ATENDIMENTO_HUMANO]')) {
                    clientesEmAtendimentoHumano.add(jid);
                    textoFinal = textoFinal.replace('[ATENDIMENTO_HUMANO]', '').trim();
                    await sock.sendMessage(jid, { text: textoFinal });
                    console.log(`[Fluxo] Cliente ${jid} passado para o modo pessoal.`);
                    continue;
                }

                await sock.sendMessage(jid, { text: textoFinal });
                
            } catch (erro) {
                console.error("Erro na esteira de produção do Gemini:", erro);
                await sock.sendPresenceUpdate('paused', jid);
            }
        }
    });
}

conectarWhatsApp();
