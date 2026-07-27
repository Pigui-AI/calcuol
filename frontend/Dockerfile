# Pigui Financial Engine — frontend estático para Cloud Run (nginx)
# Build arg: NEXT_PUBLIC_API_URL = URL del backend en Cloud Run
FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "sed -i \"s/listen 8080/listen ${PORT}/\" /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
