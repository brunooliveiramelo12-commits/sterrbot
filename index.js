const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

// Inicializa a inteligência artificial do Google
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Banco de Dados em Memória e Travas de Segurança
const clientesEmAtendimentoHumano = new Set();
const mensagensProcessadas = new Set();
const memoriaClientes = new Map(); 
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const ARQUIVO_ESTOQUE = './estoque.json';

function carregarEstoque() {
    if (!fs.existsSync(ARQUIVO_ESTOQUE)) {
        const estoqueInicial = {
            "P01": { nome: "CALÇOLA EX (Antialérgico)", varejo: 13, atacado: 12, quantidade: 50 },
            "P02": { nome: "CALÇA INFANTIL (Antialérgico)", varejo: 8, atacado: 5, quantidade: 30 },
            "P03": { nome: "CALÇA PALA (Antialérgico)", varejo: 10, atacado: 9, quantidade: 40 },
            "P04": { nome: "SUTIÃ COMUM (Antialérgico)", varejo: 12, atacado: 10, quantidade: 25 },
            "P05": { nome: "SUTIÃ NADADOR (Antialérgico)", varejo: 12, atacado: 10, quantidade: 20 },
            "P06": { nome: "SUTIÃ BOJO (Antialérgico)", varejo: 20, atacado: 18, quantidade: 35 },
            "P07": { nome: "CALÇA PMG (Antialérgico)", varejo: 10, atacado: 8, quantidade: 60 },
            "P15": { nome: "SUTIÃ COMUM PMG (Cetinete)", varejo: 25, atacado: 20, quantidade: 15 },
            "P17": { nome: "SUTIÃ BOJO PMG (Cetinete)", varejo: 30, atacado: 28, quantidade: 15 }
        };
        fs.writeFileSync(ARQUIVO_ESTOQUE, JSON.stringify(estoqueInicial, null, 2), 'utf-8');
        return estoqueInicial;
    }
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTOQUE, 'utf-8'));
}

let estoqueGlobal = carregarEstoque();

function salvarEstoque() {
    fs.writeFileSync(ARQUIVO_ESTOQUE, JSON.stringify(estoqueGlobal, null, 2), 'utf-8');
}

function gerarSystemInstruction(jid) {
    const dadosCliente = memoriaClientes.get(jid) || { etapa: "CAPTAÇÃO" };
    
    let catalogoTexto = "";
    for (const [codigo, dados] of Object.entries(estoqueGlobal)) {
        catalogoTexto += `- Código [${codigo}]: ${dados.nome} | Varejo: R$${dados.varejo} | Atacado: R$${dados.atacado} | Estoque: ${dados.quantidade} un.\n`;
    }

    return `
Você é a Ster, a gerente virtual de operações e vendas especialista da Ducarmo Exclusive (moda íntima). Seu objetivo é gerenciar todo o ciclo do cliente de forma extremamente calorosa, simpática e focada em faturamento.

Você NUNCA deve se despedir ou dizer que está saindo da conversa por conta própria. Continue atendendo a cliente normalmente até que um humano decida intervir digitalmente.

PILAR 1: CAPTAÇÃO DE LEADS (Etapa atual: ${dadosCliente.etapa})
- Descubra o nome da cliente, tamanho (P, M, G, GG, EX) e tecido preferido.
- Descubra se ela quer comprar para USO PRÓPRIO ou para REVENDA.

PILAR 2: REGRAS DE PREÇO
- USO PRÓPRIO: Atacado a partir de R$ 150,00. Abaixo disso, VAREJO.
- REVENDA: Atacado a partir de R$ 250,00. Abaixo disso, VAREJO.
- Use venda cruzada se o valor estiver perto de destravar o atacado.

PILAR 3: CONTROLE DE ESTOQUE
- Inventário físico disponível:
${catalogoTexto}
- Nunca venda produtos com estoque 0.
- Quando a cliente confirmar as peças que vai levar e aceitar fechar o pedido, insira a tag oculta [FECHAR_PEDIDO:COD1=QTD,COD2=QTD] no final do texto para nosso sistema dar baixa. Exemplo: [FECHAR_PEDIDO:P01=2]
`;
}

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ducarmo System', 'Chrome', '2.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n▼ ESCANEIE O QR CODE PARA CONECTAR O SISTEMA OPERACIONAL ▼\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const deveReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (deveReiniciar) conectarWhatsApp();
        } else if (connection === 'open') {
            console.log('\n=================================================');
            console.log('🚀 STERBOT V2.2 - MODO INTERVENÇÃO HUMANA ATIVO!');
            console.log('=================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue;

            const idMensagem = msg.key.id;
            if (mensagensProcessadas.has(idMensagem)) continue;
            mensagensProcessadas.add(idMensagem);
            
            if (mensagensProcessadas.size > 100) {
                const [primeiroId] = mensagensProcessadas;
                mensagensProcessadas.delete(primeiroId);
            }

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            // ⚡ INTEGRAÇÃO INTELIGENTE: Se você mandar QUALQUER mensagem no chat, o bot para na hora!
            if (msg.key.fromMe && textoCliente) {
                if (textoCliente === '/bot') {
                    clientesEmAtendimentoHumano.delete(jid);
                    await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Voltando a monitorar a conversa." });
                    continue;
                }
                if (
