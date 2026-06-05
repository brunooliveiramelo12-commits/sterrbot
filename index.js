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
const memoriaClientes = new Map(); // Guarda o perfil do lead (nome, tamanho, tipo_cliente)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const ARQUIVO_ESTOQUE = './estoque.json';

// Inicializa ou carrega o arquivo de estoque integrado
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

// Constrói as instruções dinâmicas injetando a nova regra de R$ 250 para revenda
function gerarSystemInstruction(jid) {
    const dadosCliente = memoriaClientes.get(jid) || { etapa: "CAPTAÇÃO" };
    
    let catalogoTexto = "";
    for (const [codigo, dados] of Object.entries(estoqueGlobal)) {
        catalogoTexto += `- Código [${codigo}]: ${dados.nome} | Varejo: R$${dados.varejo} | Atacado: R$${dados.atacado} | Estoque: ${dados.quantidade} un.\n`;
    }

    return `
Você é a Ster, a gerente virtual de operações e vendas especialista da Ducarmo Exclusive (moda íntima). Seu objetivo é gerenciar todo o ciclo do cliente de forma extremamente calorosa, simpática e focada em faturamento.

Você opera sob um sistema rígido de 4 pilares:

PILAR 1: CAPTAÇÃO DE LEADS (Sua etapa atual declarada nesta conversa: ${dadosCliente.etapa})
- Antes de vender, descubra o nome da cliente, qual tamanho ela usa (P, M, G, GG, EX) e qual tecido ela prefere (Antialérgico, Cetinete, Lycra ou Renda). 
- Descubra obrigatoriamente se ela quer comprar para USO PRÓPRIO ou se quer REVENDA.

PILAR 2: REGRAS DE OURO DE PREÇO (MUITO IMPORTANTE)
- Se a cliente quer para USO PRÓPRIO: O pedido mínimo para liberar preço de ATACADO é R$ 150,00. Abaixo disso, calcula preço de VAREJO.
- Se a cliente declarou que quer para REVENDA: O pedido mínimo para liberar preço de ATACADO é R$ 250,00. Abaixo disso, calcula preço de VAREJO.
- Estratégia de Venda Cruzada: Se o carrinho dela estiver perto do limite correspondente (ex: deu R$ 210 para revenda, ou R$ 120 para uso próprio), incentive-a com carinho a levar mais peças para bater a meta e destravar o preço de fábrica na compra inteira.

PILAR 3: CONTROLE DE ESTOQUE
- Use o seguinte inventário físico atualizado:
${catalogoTexto}
- Nunca venda produtos com estoque igual a 0.
- Quando o pedido for fechado, adicione a tag [FECHAR_PEDIDO:COD1=QTD,COD2=QTD] de forma oculta no final do texto. Exemplo: [FECHAR_PEDIDO:P01=2,P06=1]

PILAR 4: ENCAMINHAMENTO HUMANO FINANCEIRO
- Quando o cliente aceitar a soma de valores e quiser a chave de pagamento/PIX, despeça-se com carinho e use a tag [ATENDIMENTO_HUMANO].
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
            console.log('🚀 STERBOT V2.1 - SISTEMA REVENDA R$250 ATIVO!');
            console.log('=================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue;

            // TRAVA ANTI-DUPLICAÇÃO (Resolve o problema do print)
            const idMensagem = msg.key.id;
            if (mensagensProcessadas.has(idMensagem)) continue;
            mensagensProcessadas.add(idMensagem);
            
            if (mensagensProcessadas.size > 100) {
                const [primeiroId] = mensagensProcessadas;
                mensagensProcessadas.delete(primeiroId);
            }

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            // Comandos do painel administrativo da loja
            if (msg.key.fromMe && textoCliente) {
                if (textoCliente === '/bot') {
                    clientesEmAtendimentoHumano.delete(jid);
                    await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Retornando ao monitoramento de captação e controle de estoque." });
                    continue;
                }
                if (textoCliente === '/estoque') {
                    let relatorio = "📦 *ESTOQUE ATUAL DUCARMO:*\n\n";
                    for (const [cod, item] of Object.entries(estoqueGlobal)) {
                        relatorio += `• *${cod}*: ${item.nome} | Qtd: *${item.quantidade}*\n`;
                    }
                    await sock.sendMessage(jid, { text: relatorio });
                    continue;
                }
            }

            if (clientesEmAtendimentoHumano.has(jid)) continue;
            if (msg.key.fromMe || !textoCliente) continue;

            // Proteção contra spams antigos de histórico
            const timestampAgora = Math.floor(Date.now() / 1000);
            if (timestampAgora - msg.messageTimestamp > 60) continue;

            // Inicializa a memória do lead
            if (!memoriaClientes.has(jid)) {
                memoriaClientes.set(jid, { etapa: "CAPTAÇÃO", dataCriacao: Date.now() });
                
                // Disparo de Pós-Venda em segundo plano (agendado para 5 dias)
                setTimeout(async () => {
                    if (clientesEmAtendimentoHumano.has(jid)) return;
                    await sock.sendMessage(jid, { text: "Oi, minha flor! Passando para saber se suas pecinhas da Ducarmo Exclusive chegaram direitinho e se serviram perfeitamente? Quero garantir que ficou tudo lindo! 💕" });
                }, 1000 * 60 * 60 * 24 * 5);
            }

            console.log(`[Operação Log] Movimentação de ${jid}: ${textoCliente}`);

            try {
                await sock.sendPresenceUpdate('composing', jid);
                await delay(2500); // Simulador de digitação humana

                const instrucaoSistemaDinamica = gerarSystemInstruction(jid);

                const respostaGemini = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: textoCliente,
                    config: { systemInstruction: instrucaoSistemaDinamica }
                });

                let textoFinal = respostaGemini.text;
                await sock.sendPresenceUpdate('paused', jid);

                // Processamento de Baixa de Estoque
                if (textoFinal.includes('[FECHAR_PEDIDO:')) {
                    const extrairRegex = textoFinal.match(/\[FECHAR_PEDIDO:(.*?)\]/);
                    if (extrairRegex && extrairRegex[1]) {
                        const itensAgrupados = extrairRegex[1].split(',');
                        itensAgrupados.forEach(par => {
                            const [codigoItem, qtdDesejada] = par.split('=');
                            const quantidade = parseInt(qtdDesejada);
                            if (estoqueGlobal[codigoItem]) {
                                estoqueGlobal[codigoItem].quantidade = Math.max(0, estoqueGlobal[codigoItem].quantidade - quantidade);
                            }
                        });
                        salvarEstoque();
                        textoFinal = textoFinal.replace(extrairRegex[0], '').trim();
                    }
                }

                // Processamento de Direcionamento Humano
                if (textoFinal.includes('[ATENDIMENTO_HUMANO]')) {
                    clientesEmAtendimentoHumano.add(jid);
                    const dadosAtuais = memoriaClientes.get(jid);
                    if (dadosAtuais) dadosAtuais.etapa = "DIRECIONADO_AO_FINANCEIRO";

                    textoFinal = textoFinal.replace('[ATENDIMENTO_HUMANO]', '').trim();
                    await sock.sendMessage(jid, { text: textoFinal });
                    console.log(`[Fluxo de Caixa] Cliente ${jid} encaminhado ao balcão.`);
                    continue;
                }

                const dadosL = memoriaClientes.get(jid);
                if (dadosL && dadosL.etapa === "CAPTAÇÃO") {
                    dadosL.etapa = "OFERTA_E_CONVENÇÃO";
                }

                await sock.sendMessage(jid, { text: textoFinal });

            } catch (erro) {
                console.error("Falha na execução da esteira operacional:", erro);
                await sock.sendPresenceUpdate('paused', jid);
            }
        }
    });
}

conectarWhatsApp();
