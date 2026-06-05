const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

// Inicializa a inteligência artificial do Google
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Banco de Dados em Memória para Gestão de Clientes e Fluxos
const clientesEmAtendimentoHumano = new Set();
const memoriaClientes = new Map(); // Guarda: nome, tamanho, interesse, carrinho atual, timestamps
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const ARQUIVO_ESTOQUE = './estoque.json';

// Inicializa ou carrega o arquivo de estoque integrado com a planilha original
function carregarEstoque() {
    if (!fs.existsSync(ARQUIVO_ESTOQUE)) {
        // Estrutura base extraída do catálogo oficial de novos preços da Ducarmo
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

// Constrói as instruções dinâmicas injetando o inventário atualizado em tempo real
function gerarSystemInstruction(jid) {
    const dadosCliente = memoriaClientes.get(jid) || { etapa: "CAPTAÇÃO", carrinho: [] };
    
    // Converte o estoque JSON em texto legível para a IA entender o que tem disponível
    let catalogoTexto = "";
    for (const [codigo, dados] of Object.entries(estoqueGlobal)) {
        catalogoTexto += `- Código [${codigo}]: ${dados.nome} | Varejo: R$${dados.varejo} | Atacado: R$${dados.atacado} | Estoque Disponível: ${dados.quantidade} unidades.\n`;
    }

    return `
Você é a Ster, a gerente virtual de operações e vendas especialista da Ducarmo Exclusive (moda íntima). Seu objetivo é gerenciar todo o ciclo do cliente de forma extremamente calorosa, simpática e focada em faturamento.

Você opera sob um sistema rígido de 4 pilares:

PILAR 1: CAPTAÇÃO DE LEADS (Sua etapa atual declarada: ${dadosCliente.etapa})
- Antes de vender, descubra o nome da cliente, qual tamanho ela usa (P, M, G, GG, EX) e qual tecido ela prefere (Antialérgico, Cetinete, Lycra ou Renda). 
- Descubra sutilmente se ela quer comprar para uso próprio ou se quer revender.

PILAR 2: VENDA COM CONTROLE DE ESTOQUE E REGRAS DE MARGEM
- Catálogo Atualizado em Tempo Real com quantidades físicas:
${catalogoTexto}
- REGRA DE OURO: Menos de R$ 150 é VAREJO. A partir de R$ 150 libera ATACADO.
- Você NUNCA deve vender itens que estejam com estoque igual a 0.
- Se a cliente quiser fechar o pedido, calcule a soma. Se der perto de R$ 150 (ex: R$ 120), aplique vendas cruzadas (Cross-selling): estimule ela a pegar mais peças para destravar o desconto de atacado na compra inteira.
- Quando o pedido for fechado, adicione a tag [FECHAR_PEDIDO:COD1=QTD,COD2=QTD] de forma oculta no final do texto. Exemplo: [FECHAR_PEDIDO:P01=2,P06=1]

PILAR 3: PÓS-VENDA ATIVO
- Se o cliente for antigo e estiver apenas entrando em contato para dar feedback ou tirar dúvidas de um pedido que já chegou, seja a consultora de sucesso do cliente. Trate-o como prioridade.

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
            console.log('🚀 STERBOT V2.0 - SISTEMA TOTAL DUCARMO EXCLUSIVE ATIVO!');
            console.log('=================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue;

            const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            // Comando mestre para reativação e gerenciamento de estoque interno via WhatsApp
            if (msg.key.fromMe && textoCliente) {
                if (textoCliente === '/bot') {
                    clientesEmAtendimentoHumano.delete(jid);
                    await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Retornando ao monitoramento de captação e controle de estoque." });
                    continue;
                }
                // Comando secreto para o dono checar o estoque real digitando /estoque no chat
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

            // Proteção contra processamento de spams antigos pós-reinicializações
            const timestampAgora = Math.floor(Date.now() / 1000);
            if (timestampAgora - msg.messageTimestamp > 60) continue;

            // Inicializa a memória interna do lead se for um cliente novo no dia
            if (!memoriaClientes.has(jid)) {
                memoriaClientes.set(jid, { etapa: "CAPTAÇÃO", carrinho: [], dataCriacao: Date.now() });
                
                // DISPARO AUTOMÁTICO DE PÓS-VENDA (Simulação programada para 5 dias no futuro)
                // Criamos um agendador em segundo plano para monitorar esse cliente
                setTimeout(async () => {
                    if (clientesEmAtendimentoHumano.has(jid)) {
                        console.log(`[Pós-Venda] Ignorado para ${jid}, cliente está em atendimento humano.`);
                        return;
                    }
                    await sock.sendMessage(jid, { text: "Oi, minha flor! Passando para saber se suas pecinhas da Ducarmo Exclusive chegaram direitinho e se serviram perfeitamente? Quero garantir que ficou tudo lindo! 💕" });
                }, 1000 * 60 * 60 * 24 * 5); // Despara em 5 dias de forma nativa
            }

            console.log(`[Operação Log] Movimentação de ${jid}: ${textoCliente}`);

            try {
                await sock.sendPresenceUpdate('composing', jid);
                await delay(2500); // Constrói o gatilho psicológico de digitação humana

                const instrucaoSistemaDinamica = gerarSystemInstruction(jid);

                const respostaGemini = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: textoCliente,
                    config: { systemInstruction: instrucaoSistemaDinamica }
                });

                let textoFinal = respostaGemini.text;
                await sock.sendPresenceUpdate('paused', jid);

                // PROCESSAMENTO PILAR 3: Captura de Ordem de Compra e Baixa no Estoque JSON
                if (textoFinal.includes('[FECHAR_PEDIDO:')) {
                    const extrairRegex = textoFinal.match(/\[FECHAR_PEDIDO:(.*?)\]/);
                    if (extrairRegex && extrairRegex[1]) {
                        const itensAgrupados = extrairRegex[1].split(','); // ex: ["P01=2", "P06=1"]
                        let logBaixaEstoque = "📉 *Alteração de Estoque Real:* \n";
                        
                        itensAgrupados.forEach(par => {
                            const [codigoItem, qtdDesejada] = par.split('=');
                            const quantidade = parseInt(qtdDesejada);
                            
                            if (estoqueGlobal[codigoItem]) {
                                // Aplica a subtração matemática no JSON físico
                                estoqueGlobal[codigoItem].quantidade = Math.max(0, estoqueGlobal[codigoItem].quantidade - quantidade);
                                logBaixaEstoque += `✔️ Item ${codigoItem} reduzido em ${quantidade} unidades.\n`;
                            }
                        });

                        salvarEstoque(); // Persiste os novos dados físicos no estoque.json
                        console.log(logBaixaEstoque);
                        // Limpa a tag técnica para o texto ir limpo ao WhatsApp do cliente
                        textoFinal = textoFinal.replace(extrairRegex[0], '').trim();
                    }
                }

                // PROCESSAMENTO PILAR 4: Transferência para o Fechamento no Balcão (Humano)
                if (textoFinal.includes('[ATENDIMENTO_HUMANO]')) {
                    clientesEmAtendimentoHumano.add(jid);
                    // Passa o status do lead para Finalizado
                    const dadosAtuais = memoriaClientes.get(jid);
                    if (dadosAtuais) dadosAtuais.etapa = "DIRECIONADO_AO_FINANCEIRO";

                    textoFinal = textoFinal.replace('[ATENDIMENTO_HUMANO]', '').trim();
                    await sock.sendMessage(jid, { text: textoFinal });
                    console.log(`[Fluxo de Caixa] Cliente ${jid} encaminhado ao balcão/PIX.`);
                    continue;
                }

                // Atualiza o avanço natural do cliente para a fase de vendas após o primeiro contato
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
