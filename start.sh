docker stop shellshock
docker rm shellshock
docker build -t shellshock .
docker run -d --name shellshock -p 20128:20128 --env-file .env -v shellshock-data:/app/data shellshock
