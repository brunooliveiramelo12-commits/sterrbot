// Adicione esta linha logo abaixo de "const clientesEmAtendimentoHumano = new Set();" no início do arquivo:
const mensagensProcessadas = new Set();

// Substitua todo o bloco 'messages.upsert' por este:
sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue; // Proteção contra grupos

        // TRAVA ANTI-DUPLICAÇÃO: Ignora se a mensagem já foi processada pelo servidor
        const idMensagem = msg.key.id;
        if (mensagensProcessadas.has(idMensagem)) continue;
        mensagensProcessadas.add(idMensagem);
        
        // Limpa o cache de IDs antigos a cada 100 mensagens para não pesar o servidor
        if (mensagensProcessadas.size > 100) {
            const [primeiroId] = mensagensProcessadas;
            mensagensProcessadas.delete(primeiroId);
        }

        const textoCliente = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

        // Comando do Dono para reativar o Bot
        if (msg.key.fromMe && textoCliente === '/bot') {
            clientesEmAtendimentoHumano.delete(jid);
            await sock.sendMessage(jid, { text: "🤖 *Ster Reativada!* Voltei a cuidar do atendimento automático desta conversa lindeza." });
            continue;
        }

        // Comando do Dono para checar estoque
        if (msg.key.fromMe && textoCliente === '/estoque') {
            let relatorio = "📦 *ESTOQUE ATUAL DUCARMO:*\n\n";
            for (const [cod, item] of Object.entries(estoqueGlobal)) {
                relatorio += `• *${cod}*: ${item.nome} | Qtd: *${item.quantidade}*\n`;
            }
            await sock.sendMessage(jid, { text: relatorio });
            continue;
        }

        if (clientesEmAtendimentoHumano.has(jid)) continue;
        if (msg.key.fromMe) continue;
        if (!textoCliente) continue;

        // PROTEÇÃO DE PRODUÇÃO: Ignora mensagens enviadas há mais de 60 segundos (mensagens antigas de histórico)
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

            const instrucaoSistemaDinamica = gerarSystemInstruction(jid);

            const respostaGemini = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: textoCliente,
                config: { systemInstruction: instrucaoSistemaDinamica }
            });

            let textoFinal = respostaGemini.text;
            await sock.sendPresenceUpdate('paused', jid);

            // PROCESSAMENTO: Captura de Ordem de Compra e Baixa no Estoque JSON
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

            // PROCESSAMENTO: Transferência para o Humano
            if (textoFinal.includes('[ATENDIMENTO_HUMANO]')) {
                clientesEmAtendimentoHumano.add(jid);
                const dadosAtuais = memoriaClientes.get(jid);
                if (dadosAtuais) dadosAtuais.etapa = "DIRECIONADO_AO_FINANCEIRO";

                textoFinal = textoFinal.replace('[ATENDIMENTO_HUMANO]', '').trim();
                await sock.sendMessage(jid, { text: textoFinal });
                console.log(`[Fluxo de Caixa] Cliente ${jid} encaminhado ao balcão/PIX.`);
                continue;
            }

            const dadosL = memoriaClientes.get(jid);
            if (dadosL && dadosL.etapa === "CAPTAÇÃO") {
                dadosL.etapa = "OFERTA_E_CONVENÇÃO";
            }

            await sock.sendMessage(jid, { text: textoFinal });
            
        } catch (erro) {
            console.error("Erro na esteira de produção do Gemini:", erro);
            await sock.sendPresenceUpdate('paused', jid);
        }
    }
});
