# Planejador de viagem com backend

## Rodar
    node server.js          # precisa de Node 18+; abre em http://localhost:3000

Opcional: `PORT=8080 APP_TOKEN=segredo node server.js` (com token, a API exige o header `x-token`).

## O que o backend automatiza
- Salva a viagem em `data/trip.json` (some do navegador? não perde nada) e fotos em `data/uploads/`.
- Cole o link do Airbnb/site: preenche nome, preço e foto sozinho (`/api/preview`).
- Cidades: sugestões reais do OpenStreetMap (`/api/places`), sem lista fixa.
- Aba Restaurantes: sugestões reais de restaurantes, cafés e bares da cidade (OpenStreetMap/Overpass, `/api/restaurants`), com filtro, raio e botão Salvar.
- Previsão do tempo por cidade no Resumo (Open-Meteo, até ~16 dias à frente).
- Exportar roteiro para o calendário (.ics) e baixar backup.
- Dados antigos do localStorage são migrados na primeira abertura.

Obs.: sites como Airbnb às vezes bloqueiam leitura automática; nesse caso o formulário continua manual.
