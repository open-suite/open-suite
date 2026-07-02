FROM python:3.13-alpine

# PyJWT + cryptography: Bearer tokens are verified against the realm JWKS.
RUN pip install --no-cache-dir "PyJWT[crypto]==2.10.1"

WORKDIR /app
COPY server.py /app/server.py

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["python", "/app/server.py"]
