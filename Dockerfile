FROM node:20-alpine

# Install curl for the docker-compose healthcheck
RUN apk --no-cache add curl

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
