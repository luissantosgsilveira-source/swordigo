# Publicar o servidor Swordigo Co-op no Render

Este pacote contém somente o servidor de salas. Ele não inclui o APK nem os arquivos do jogo.

## O que você vai precisar

- Uma conta do GitHub.
- Uma conta do Render.
- Git instalado no computador. Se o comando do arquivo `.cmd` disser que `git` não existe, instale o Git for Windows e abra o arquivo de novo.

## Passos

1. Crie um repositório **privado e vazio** no GitHub. Não marque as opções para criar README, licença ou `.gitignore`.
2. Baixe e extraia `Swordigo-Coop-Render.zip`.
3. Abra `Enviar-para-GitHub.cmd`, cole o endereço HTTPS do repositório privado e aperte Enter. O GitHub pode abrir uma janela para você entrar na sua conta; não envie sua senha para mim.
4. No Render, escolha **New + → Blueprint** e conecte sua conta GitHub se o site pedir.
5. Escolha o repositório criado. O Render vai ler `render.yaml`; confirme o plano **Free** e publique.
6. Quando o serviço ficar como **Live**, copie o endereço `https://...onrender.com` e me envie somente esse endereço. Não envie senha nem token.

Depois, eu coloco esse endereço no APK e gero outra versão. As salas atuais suportam dois jogadores. O plano gratuito pode dormir depois de 15 minutos sem tráfego; quando uma sala está em uso, os celulares mandam mensagens de manutenção para mantê-la ativa. Se o Render reiniciar, as salas que estavam abertas são encerradas.
