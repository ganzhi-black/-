FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip antiword \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY server/requirements.txt ./server/requirements.txt
RUN python3 -m pip install --break-system-packages --target /app/server/python-vendor -r server/requirements.txt

COPY . .

ENV NODE_ENV=production
ENV PYTHON_BIN=python3
ENV DOCUMENT_CONVERTER=markitdown

CMD ["npm", "run", "server"]
