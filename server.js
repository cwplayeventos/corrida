import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { MercadoPagoConfig, Order } from "mercadopago";
import { google } from "googleapis";

const app = express();

const PORT = process.env.PORT || 3000;

/* =========================================================
   CONFIGURAÇÕES
========================================================= */

const kits = {
  basico: {
    name: "Corrida / Caminhada",
    price: 19.90,
    shirt: false
  },

  medalha: {
    name: "Com Medalha",
    price: 39.90,
    shirt: false
  },

  completo: {
    name: "Kit Completo",
    price: 59.90,
    shirt: true
  }
};

/*
  No Render:
  
  FRONTEND_ORIGIN=https://cwplayeventos.github.io

  Se estiver testando o Mercado Pago:
  
  MERCADOPAGO_SANDBOX=true

  Quando passar para produção:
  
  MERCADOPAGO_SANDBOX=false
*/

const isSandbox =
  String(process.env.MERCADOPAGO_SANDBOX || "true").toLowerCase() === "true";


/* =========================================================
   CORS
========================================================= */

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {

      // Permite ferramentas como Postman/PowerShell
      if (!origin) {
        return callback(null, true);
      }

      // Se não houver configuração de origem, permite
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origem não permitida."));
    }
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);


/* =========================================================
   MERCADO PAGO
========================================================= */

if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
  console.warn(
    "ATENÇÃO: MERCADOPAGO_ACCESS_TOKEN não configurado."
  );
}

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});

const orderClient = new Order(mpClient);


/* =========================================================
   FUNÇÕES AUXILIARES
========================================================= */

function brl(value) {
  return Number(value).toFixed(2);
}


function clean(value) {
  return String(value ?? "")
    .trim()
    .replace(/[<>]/g, "");
}


function registrationId() {
  return (
    "GDB-" +
    Date.now().toString().slice(-8) +
    Math.floor(Math.random() * 90 + 10)
  );
}


/* =========================================================
   E-MAIL PARA O MERCADO PAGO
========================================================= */

/*
  O formulário da corrida não precisa pedir e-mail.

  No Sandbox do Mercado Pago, entretanto, o payer.email
  precisa terminar com @testuser.com.

  Portanto:

  SANDBOX:
    gera automaticamente:
    inscricao-XXXXXXXX@testuser.com

  PRODUÇÃO:
    usa o e-mail informado.

  Se não houver e-mail em produção, utiliza um endereço
  padrão válido da operação.
*/

function getPayerEmail(responsible, registrationIdValue) {

  const suppliedEmail = clean(responsible?.email);

  if (isSandbox) {

    // Se já foi informado um e-mail @testuser.com,
    // podemos utilizá-lo.
    if (
      suppliedEmail &&
      suppliedEmail.toLowerCase().endsWith("@testuser.com")
    ) {
      return suppliedEmail;
    }

    // Caso contrário, criamos automaticamente.
    const safeId = String(registrationIdValue)
      .replace(/[^a-zA-Z0-9-]/g, "")
      .toLowerCase();

    return `${safeId}@testuser.com`;
  }

  // PRODUÇÃO

  if (suppliedEmail) {
    return suppliedEmail;
  }

  // E-mail padrão da operação.
  return "cwplayeventos@gmail.com";
}


/* =========================================================
   VALIDAÇÃO E CÁLCULO
========================================================= */

function totalOf(participants) {

  return participants.reduce((sum, participant) => {

    const kit = kits[participant.kitId];

    if (!kit) {
      throw new Error("Kit inválido.");
    }

    if (
      !["2,5 km", "5 km"].includes(
        participant.distance
      )
    ) {
      throw new Error("Distância inválida.");
    }

    if (
      !["Corrida", "Caminhada"].includes(
        participant.mode
      )
    ) {
      throw new Error("Modalidade inválida.");
    }

    if (
      kit.shirt &&
      !participant.shirt
    ) {
      throw new Error(
        "Tamanho da camiseta obrigatório."
      );
    }

    return sum + kit.price;

  }, 0);
}


/* =========================================================
   GOOGLE SHEETS
========================================================= */

async function sheetsAuth() {

  if (
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !process.env.GOOGLE_PRIVATE_KEY
  ) {
    throw new Error(
      "Credenciais do Google Sheets não configuradas."
    );
  }

  const auth = new google.auth.JWT({

    email:
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,

    key:
      process.env.GOOGLE_PRIVATE_KEY
        .replace(/\\n/g, "\n"),

    scopes: [
      "https://www.googleapis.com/auth/spreadsheets"
    ]

  });

  return google.sheets({
    version: "v4",
    auth
  });
}


/* =========================================================
   SALVAR INSCRIÇÃO
========================================================= */

async function appendRegistration(
  registration,
  participants
) {

  if (
    !process.env.GOOGLE_SHEET_ID ||
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !process.env.GOOGLE_PRIVATE_KEY
  ) {
    console.warn(
      "Google Sheets não configurado. Inscrição não será salva na planilha."
    );

    return;
  }

  const sheets = await sheetsAuth();

  const now = new Date().toISOString();


  /* -----------------------------
     ABA INSCRIÇÕES
  ----------------------------- */

  await sheets.spreadsheets.values.append({

    spreadsheetId:
      process.env.GOOGLE_SHEET_ID,

    range:
      "Inscrições!A:J",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        registration.id,

        now,

        registration.responsible.name,

        registration.responsible.whatsapp,

        participants.length,

        registration.total,

        "PENDENTE",

        registration.mpOrderId || "",

        registration.pixId || "",

        now

      ]]

    }

  });


  /* -----------------------------
     ABA PARTICIPANTES
  ----------------------------- */

  await sheets.spreadsheets.values.append({

    spreadsheetId:
      process.env.GOOGLE_SHEET_ID,

    range:
      "Participantes!A:J",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values:
        participants.map((participant, index) => [

          `${registration.id}-${String(index + 1).padStart(2, "0")}`,

          registration.id,

          participant.name,

          participant.whatsapp,

          participant.mode,

          participant.distance,

          kits[participant.kitId].name,

          participant.shirt || "",

          kits[participant.kitId].price,

          "PENDENTE"

        ])

    }

  });
}


/* =========================================================
   ATUALIZAR PAGAMENTO NA PLANILHA
========================================================= */

async function updateRegistrationPaid(
  registrationIdValue,
  mercadoPagoId,
  status
) {

  if (
    !process.env.GOOGLE_SHEET_ID ||
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !process.env.GOOGLE_PRIVATE_KEY
  ) {
    return;
  }

  const sheets = await sheetsAuth();


  /* -----------------------------
     LOCALIZAR INSCRIÇÃO
  ----------------------------- */

  const result =
    await sheets.spreadsheets.values.get({

      spreadsheetId:
        process.env.GOOGLE_SHEET_ID,

      range:
        "Inscrições!A:J"

    });


  const rows =
    result.data.values || [];


  const index =
    rows.findIndex(
      (row, i) =>
        i > 0 &&
        String(row[0]) ===
        String(registrationIdValue)
    );


  if (index < 1) {
    console.warn(
      "Inscrição não encontrada na planilha:",
      registrationIdValue
    );

    return;
  }


  /* -----------------------------
     ATUALIZA STATUS
  ----------------------------- */

  await sheets.spreadsheets.values.update({

    spreadsheetId:
      process.env.GOOGLE_SHEET_ID,

    range:
      `Inscrições!G${index + 1}:J${index + 1}`,

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        status,

        mercadoPagoId || "",

        rows[index][8] || "",

        new Date().toISOString()

      ]]

    }

  });


  /* -----------------------------
     ATUALIZA PARTICIPANTES
  ----------------------------- */

  const participantsResult =
    await sheets.spreadsheets.values.get({

      spreadsheetId:
        process.env.GOOGLE_SHEET_ID,

      range:
        "Participantes!A:J"

    });


  const participantRows =
    participantsResult.data.values || [];


  for (
    let i = 1;
    i < participantRows.length;
    i++
  ) {

    const row =
      participantRows[i];

    if (
      String(row[1]) ===
      String(registrationIdValue)
    ) {

      await sheets.spreadsheets.values.update({

        spreadsheetId:
          process.env.GOOGLE_SHEET_ID,

        range:
          `Participantes!J${i + 1}`,

        valueInputOption:
          "USER_ENTERED",

        requestBody: {

          values: [[status]]

        }

      });

    }

  }

}


/* =========================================================
   CRIAR ORDER PIX NO MERCADO PAGO
========================================================= */

async function createMpOrder(
  registrationIdValue,
  total,
  responsible
) {

  const expirationMinutes =
    Number(
      process.env.PIX_EXPIRATION_MINUTES || 30
    );


  if (
    !Number.isFinite(expirationMinutes) ||
    expirationMinutes < 30
  ) {
    throw new Error(
      "PIX_EXPIRATION_MINUTES deve ser no mínimo 30."
    );
  }


  const expires =
    new Date(
      Date.now() +
      expirationMinutes * 60000
    );


  const payerEmail =
    getPayerEmail(
      responsible,
      registrationIdValue
    );


  console.log(
    "Criando Order Mercado Pago:",
    {
      registrationId:
        registrationIdValue,

      total:
        brl(total),

      sandbox:
        isSandbox,

      payerEmail:
        payerEmail
    }
  );


  const order =
    await orderClient.create({

      body: {

        type: "online",

        total_amount:
          brl(total),

        external_reference:
          registrationIdValue,

        processing_mode:
          "automatic",

        transactions: {

          payments: [

            {

              amount:
                brl(total),

              payment_method: {

                id: "pix",

                type: "bank_transfer"

              },

              expiration_time:
                `PT${expirationMinutes}M`

            }

          ]

        },

        payer: {

          email:
            payerEmail

        }

      },

      requestOptions: {

        idempotencyKey:
          crypto.randomUUID()

      }

    });


  console.log(
    "Order Mercado Pago criada:",
    order?.id
  );


  const payment =
    order?.transactions?.payments?.[0];


  const paymentMethod =
    payment?.payment_method;


  if (
    !paymentMethod?.qr_code ||
    !paymentMethod?.qr_code_base64
  ) {

    console.error(
      "Resposta do Mercado Pago sem QR Code:",
      JSON.stringify(order, null, 2)
    );

    throw new Error(
      "Mercado Pago não retornou os dados do Pix."
    );

  }


  return {

    orderId:
      order.id,

    paymentId:
      payment.id,

    pixCode:
      paymentMethod.qr_code,

    qrCodeBase64:
      paymentMethod.qr_code_base64,

    expiresAt:
      expires.toISOString()

  };

}


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "guerreiros-baca",

      version:
        "2.0",

      mercadopago:
        isSandbox
          ? "sandbox"
          : "production"

    });

  }
);


/* =========================================================
   CRIAR INSCRIÇÃO + PIX
========================================================= */

app.post(
  "/api/registrations",
  async (req, res) => {

    try {

      const {
        responsible,
        participants
      } = req.body || {};


      /* -----------------------------
         RESPONSÁVEL
      ----------------------------- */

      if (
        !responsible?.name ||
        !responsible?.whatsapp
      ) {

        throw new Error(
          "Informe o responsável e o WhatsApp."
        );

      }


      /* -----------------------------
         PARTICIPANTES
      ----------------------------- */

      if (
        !Array.isArray(participants) ||
        participants.length < 1 ||
        participants.length > 20
      ) {

        throw new Error(
          "Quantidade de participantes inválida."
        );

      }


      /* -----------------------------
         NORMALIZAÇÃO
      ----------------------------- */

      const normalized =
        participants.map(
          participant => ({

            name:
              clean(participant.name),

            whatsapp:
              clean(participant.whatsapp),

            mode:
              clean(participant.mode),

            distance:
              clean(participant.distance),

            kitId:
              clean(participant.kitId),

            shirt:
              clean(participant.shirt)

          })
        );


      /* -----------------------------
         CAMPOS OBRIGATÓRIOS
      ----------------------------- */

      if (
        normalized.some(
          participant =>
            !participant.name ||
            !participant.whatsapp ||
            !participant.mode ||
            !participant.distance ||
            !participant.kitId
        )
      ) {

        throw new Error(
          "Preencha todos os dados dos participantes."
        );

      }


      /* -----------------------------
         TOTAL
      ----------------------------- */

      const total =
        totalOf(normalized);


      /* -----------------------------
         ID DA INSCRIÇÃO
      ----------------------------- */

      const id =
        registrationId();


      /* -----------------------------
         CRIAR PIX
      ----------------------------- */

      const mp =
        await createMpOrder(
          id,
          total,
          {
            email:
              clean(responsible.email)
          }
        );


      /* -----------------------------
         OBJETO DA INSCRIÇÃO
      ----------------------------- */

      const registration = {

        id,

        responsible: {

          name:
            clean(responsible.name),

          whatsapp:
            clean(responsible.whatsapp),

          email:
            clean(responsible.email)

        },

        total,

        mpOrderId:
          mp.orderId,

        pixId:
          mp.paymentId

      };


      /* -----------------------------
         GOOGLE SHEETS
      ----------------------------- */

      await appendRegistration(
        registration,
        normalized
      );


      /* -----------------------------
         RESPOSTA
      ----------------------------- */

      res.json({

        success: true,

        registrationId:
          id,

        total,

        ...mp

      });

    } catch (error) {

      console.error(
        "ERRO /api/registrations:",
        error
      );


      /*
        Erros de validação:
        400

        Erros de Mercado Pago:
        também retornamos 400 para o frontend,
        mas o log do Render mostra o erro real.
      */

      res.status(400).json({

        success: false,

        message:
          error?.message ||
          "Não foi possível criar a inscrição.",

        error:
          process.env.NODE_ENV === "development"
            ? String(error)
            : undefined

      });

    }

  }
);


/* =========================================================
   CONSULTAR ORDER
========================================================= */

async function getOrder(id) {

  return await orderClient.get({
    id
  });

}


/* =========================================================
   CONSULTAR STATUS DA INSCRIÇÃO
========================================================= */

app.get(
  "/api/registrations/:id/status",
  async (req, res) => {

    try {

      if (
        !process.env.GOOGLE_SHEET_ID
      ) {

        return res.json({
          status: "PENDENTE"
        });

      }


      const sheets =
        await sheetsAuth();


      const data =
        await sheets.spreadsheets.values.get({

          spreadsheetId:
            process.env.GOOGLE_SHEET_ID,

          range:
            "Inscrições!A:J"

        });


      const rows =
        data.data.values || [];


      const row =
        rows.find(
          (r, i) =>
            i > 0 &&
            String(r[0]) ===
            String(req.params.id)
        );


      if (!row) {

        return res.status(404).json({

          message:
            "Inscrição não encontrada."

        });

      }


      /*
        Coluna H:
        Mercado Pago Order ID
      */

      const mpOrderId =
        row[7];


      if (!mpOrderId) {

        return res.json({

          status:
            row[6] ||
            "PENDENTE"

        });

      }


      const order =
        await getOrder(mpOrderId);


      const status =
        order?.status;


      const paymentProcessed =
        order?.transactions?.payments?.some(
          payment =>
            payment.status ===
            "processed"
        );


      const paid =
        status === "processed" ||
        status === "approved" ||
        paymentProcessed;


      if (
        paid &&
        row[6] !== "PAGO"
      ) {

        await updateRegistrationPaid(
          req.params.id,
          mpOrderId,
          "PAGO"
        );

      }


      return res.json({

        status:
          paid
            ? "PAGO"
            : (
                status ||
                row[6] ||
                "PENDENTE"
              )

      });

    } catch (error) {

      console.error(
        "ERRO CONSULTANDO STATUS:",
        error
      );


      return res.status(500).json({

        message:
          "Não foi possível consultar o pagamento."

      });

    }

  }
);


/* =========================================================
   GERAR NOVO PIX
========================================================= */

app.post(
  "/api/registrations/:id/pix",
  async (req, res) => {

    try {

      if (
        !process.env.GOOGLE_SHEET_ID
      ) {

        throw new Error(
          "Google Sheets não configurado."
        );

      }


      const sheets =
        await sheetsAuth();


      const data =
        await sheets.spreadsheets.values.get({

          spreadsheetId:
            process.env.GOOGLE_SHEET_ID,

          range:
            "Inscrições!A:J"

        });


      const rows =
        data.data.values || [];


      const row =
        rows.find(
          (r, i) =>
            i > 0 &&
            String(r[0]) ===
            String(req.params.id)
        );


      if (!row) {

        throw new Error(
          "Inscrição não encontrada."
        );

      }


      if (
        row[6] === "PAGO"
      ) {

        throw new Error(
          "Esta inscrição já está paga."
        );

      }


      const mp =
        await createMpOrder(

          req.params.id,

          Number(row[5]),

          {
            email:
              "cwplayeventos@gmail.com"
          }

        );


      const index =
        rows.findIndex(
          r =>
            String(r[0]) ===
            String(req.params.id)
        );


      await sheets.spreadsheets.values.update({

        spreadsheetId:
          process.env.GOOGLE_SHEET_ID,

        range:
          `Inscrições!H${index + 1}:I${index + 1}`,

        valueInputOption:
          "USER_ENTERED",

        requestBody: {

          values: [[

            mp.orderId,

            mp.paymentId

          ]]

        }

      });


      res.json({

        success: true,

        registrationId:
          req.params.id,

        total:
          Number(row[5]),

        ...mp

      });

    } catch (error) {

      console.error(
        "ERRO GERANDO NOVO PIX:",
        error
      );


      res.status(400).json({

        success: false,

        message:
          error?.message ||
          "Não foi possível gerar o Pix."

      });

    }

  }
);


/* =========================================================
   WEBHOOK MERCADO PAGO
========================================================= */

app.post(
  "/api/webhooks/mercadopago",
  async (req, res) => {

    try {

      /*
        Validação HMAC.

        Deixe MERCADOPAGO_WEBHOOK_SECRET
        vazio enquanto estivermos configurando
        o primeiro teste.

        Depois vamos configurar corretamente
        a assinatura.
      */

      const secret =
        process.env.MERCADOPAGO_WEBHOOK_SECRET;


      if (secret) {

        const signature =
          String(
            req.headers["x-signature"] ||
            ""
          );


        const requestId =
          String(
            req.headers["x-request-id"] ||
            ""
          );


        const dataId =
          String(
            req.query["data.id"] ||
            req.body?.data?.id ||
            ""
          );


        const timestamp =
          (
            signature.match(
              /(?:^|,)ts=([^,]+)/
            ) || []
          )[1];


        const receivedHash =
          (
            signature.match(
              /(?:^|,)v1=([^,]+)/
            ) || []
          )[1];


        if (
          !timestamp ||
          !receivedHash ||
          !requestId ||
          !dataId
        ) {

          return res.sendStatus(401);

        }


        const manifest =
          `id:${dataId};request-id:${requestId};ts:${timestamp};`;


        const expectedHash =
          crypto
            .createHmac(
              "sha256",
              secret
            )
            .update(manifest)
            .digest("hex");


        const expectedBuffer =
          Buffer.from(
            expectedHash,
            "utf8"
          );


        const receivedBuffer =
          Buffer.from(
            receivedHash,
            "utf8"
          );


        if (
          expectedBuffer.length !==
          receivedBuffer.length
        ) {

          return res.sendStatus(401);

        }


        if (
          !crypto.timingSafeEqual(
            expectedBuffer,
            receivedBuffer
          )
        ) {

          return res.sendStatus(401);

        }

      }


      /*
        Respondemos rapidamente ao Mercado Pago.
      */

      res.sendStatus(200);


      const orderId =
        req.body?.data?.id ||
        req.query["data.id"];


      if (!orderId) {

        return;

      }


      console.log(
        "Webhook Mercado Pago recebido:",
        orderId
      );


      /*
        Consulta a Order diretamente no Mercado Pago.
      */

      const order =
        await getOrder(orderId);


      const paid =
        order?.status === "processed" ||
        order?.status === "approved" ||
        order?.transactions?.payments?.some(
          payment =>
            payment.status ===
            "processed"
        );


      if (!paid) {

        console.log(
          "Order ainda não está paga:",
          orderId,
          order?.status
        );

        return;

      }


      const registrationIdValue =
        order?.external_reference;


      if (!registrationIdValue) {

        console.warn(
          "Order sem external_reference:",
          orderId
        );

        return;

      }


      console.log(
        "PAGAMENTO CONFIRMADO:",
        {
          orderId,
          registrationId:
            registrationIdValue
        }
      );


      await updateRegistrationPaid(

        registrationIdValue,

        orderId,

        "PAGO"

      );


    } catch (error) {

      console.error(
        "ERRO WEBHOOK MERCADO PAGO:",
        error
      );

    }

  }
);


/* =========================================================
   TRATAMENTO DE ERROS DO EXPRESS
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "ERRO EXPRESS:",
      error
    );


    if (
      error?.message ===
      "Origem não permitida."
    ) {

      return res.status(403).json({

        success: false,

        message:
          "Origem não permitida."

      });

    }


    return res.status(500).json({

      success: false,

      message:
        "Erro interno do servidor."

    });

  }
);


/* =========================================================
   INICIAR SERVIDOR
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Backend rodando na porta ${PORT}`
    );

    console.log(
      `Mercado Pago: ${
        isSandbox
          ? "SANDBOX"
          : "PRODUÇÃO"
      }`
    );

    console.log(
      `Frontend permitido: ${
        process.env.FRONTEND_ORIGIN ||
        "qualquer origem"
      }`
    );

  }
);
