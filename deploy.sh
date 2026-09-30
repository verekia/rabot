docker buildx build --platform linux/arm64 --load -t verekia/rabot .
docker save verekia/rabot | gzip > /tmp/rabot.tar.gz
scp /tmp/rabot.tar.gz midgar:/tmp/
ssh midgar docker load --input /tmp/rabot.tar.gz
ssh midgar docker compose up -d rabot
