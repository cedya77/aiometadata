# Etapa de construção do frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Copia os arquivos de configuração primeiro
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante do código fonte
COPY . .

# Build da aplicação React
RUN npm run build

# Build do backend TypeScript
RUN npm run build:backend

# Etapa de produção
FROM node:20-alpine AS runner

WORKDIR /app

# Copia apenas os arquivos necessários
COPY package*.json ./

# Instala apenas dependências de produção
RUN npm install --production

# Copia os arquivos do servidor
COPY --from=builder /app/addon ./addon

# Copia os arquivos buildados do React
COPY --from=builder /app/dist ./dist

# Copia a pasta public com as imagens
COPY --from=builder /app/public ./public

# Exposição da porta
EXPOSE 1337

# Comando para iniciar o servidor
ENTRYPOINT ["node", "dist/server.js"] 