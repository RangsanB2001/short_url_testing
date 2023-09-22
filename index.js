const express = require("express");
const shortid = require("shortid");
const QRCode = require("qrcode");
const session = require("cookie-session");
const bcrypt = require("bcryptjs");
const dbConnection = require("./connectDB");
const path = require("path");
const bodyParser = require("body-parser");
const { body, validationResult } = require("express-validator");
const PORT = process.env.PORT || 4000;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, "/public/")));
app.set("views", path.join(__dirname, "public"));
app.set("view engine", "ejs");

app.use(
  session({
    name: "session",
    secret: "my-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 3600 * 1000, // 1hr
    },
  })
);

app.get("/qr", (req, res) => {
  res.render("qrcode");
});

app.get("/loginpage", (req, res) => {
  res.render("login");
});

app.get("/regpage", (req, res) => {
  res.render("register");
});

const NotlogIn = async (req, res, next) => {
  if (!req.session.isLogIn) {
    if (req.session.userID) {
      getLinks(req, res);
    } else {
      res.render("home", {
        name: "",
        result: [],
      });
    }
  } else {
    res.redirect("/home");
  }
};

const LoggedIn = async (req, res, next) => {
  if (req.session.isLogIn) {
    try {
      const linksWithQRCode = await getLinksWithQRCodeByUser(
        req.session.userID
      );
      req.linksWithQRCode = linksWithQRCode;
      res.redirect("/home");
    } catch (error) {
      console.error("Error fetching links with QR codes:", error);
      req.linksWithQRCode = [];
      res.redirect("/home");
    }
  } else {
    next();
  }
};

app.get("/", NotlogIn, LoggedIn, async (req, res, next) => {
  try {
    if (req.session.isLogIn && req.session.userID) {
      const [rows] = await dbConnection.execute(
        "SELECT email FROM users WHERE user_id = ?",
        [req.session.userID]
      );

      res.render("home", {
        name: rows[0].email,
        result: req.linksWithQRCode,
      });
    } else {
      res.render("home", {
        name: "",
        result: [],
      });
    }
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Internal server error");
  }
});

app.post(
  "/register",
  LoggedIn,
  [
    body("user_email", "Invalid Email Address !!")
      .isEmail()
      .custom((value) => {
        return dbConnection
          .execute("SELECT email FROM users WHERE email = :email", {
            email: value,
          })
          .then(([rows]) => {
            if (rows.length > 0) {
              return Promise.reject("This email already in use!");
            }
            return true;
          });
      }),
    body("user_pass", "The password must be of minimum length 8 characters")
      .trim()
      .isLength({ min: 8 }),
  ],
  async (req, res, next) => {
    const validation_result = validationResult(req);
    const { user_email, user_pass } = req.body;

    if (validation_result.isEmpty()) {
      try {
        const hash_pass = await bcrypt.hash(user_pass, 8);
        const result = await dbConnection.execute(
          "INSERT INTO users (email, password) VALUES (:email, :pass)",
          {
            email: user_email,
            pass: hash_pass,
          }
        );

        res.render("login", {
          message:
            "Your account has been created successfully. Now you can <a href='/'>Login</a>",
        });
      } catch (err) {
        console.error("Database error:", err);
        res.status(500).send("Internal server error");
      }
    } else {
      let allErrors = validation_result.errors.map((error) => {
        return error.msg;
      });
      res.render("register", {
        register_error: allErrors,
        old_data: req.body,
      });
    }
  }
);

app.post(
  "/login",
  LoggedIn,
  [
    body("user_email").custom((value) => {
      return dbConnection
        .execute("SELECT * FROM users WHERE email = :email", {
          email: value,
        })
        .then(([rows]) => {
          if (rows.length === 1) {
            return rows[0];
          }
          return Promise.reject("Invalid Email Address!");
        });
    }),
    body("user_pass", "Password is Empty").trim().not().isEmpty(),
  ],
  async (req, res) => {
    const validation_result = validationResult(req);
    const { user_pass } = req.body;

    if (validation_result.isEmpty()) {
      const user = await validation_result.mapped().user_email;
      if (user && user.password) {
        const compare_result = await bcrypt.compare(user_pass, user.password);
        if (compare_result === true) {
          req.session.isLogIn = true;
          req.session.userID = user.user_id;
          res.redirect("/home");
        } else {
          res.render("login", {
            login_error: ["Invalid Password"],
          });
        }
      } else {
        res.render("login", {
          login_error: ["Invalid Email Address or Password"],
        });
      }
    } else {
      let allErrors = validation_result.errors.map((error) => {
        return error.msg;
      });
      res.render("login", {
        login_errors: allErrors,
      });
    }
  }
);

async function getLinks(req, res) {
  try {
    if (!req.session.isLogIn) {
      const [rows] = await dbConnection.execute(
        "SELECT * FROM url ORDER BY URL_ID DESC"
      );
      res.render("home", { result: rows });
    } else {
      const userId = req.session.userID;
      const [rows] = await dbConnection.execute(
        "SELECT * FROM url WHERE url_id = ? ORDER BY ID DESC",
        [userId]
      );
      res.render("home", { result: rows });
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("Internal server error");
  }
}

async function getLinksWithQRCodeByUser(userId) {
  try {
    const [rows] = await dbConnection.execute(
      "SELECT * FROM user_urls WHERE user_id = ? ORDER BY url_id DESC",
      [userId]
    );
    const linksWithQRCode = await Promise.all(
      rows.map(async (row) => {
        const qrCodeDataUrl = await generateQRCode(row.shorturl);
        return { ...row, qrCodeDataUrl };
      })
    );
    return linksWithQRCode;
  } catch (error) {
    console.error("Database error:", error);
    throw error;
  }
}

app.post("/genQrcode", async (req, res) => {
  // Get the URL from the request body
  const inputText = req.body.inputText;

  try {
    // Generate the QR Code
    const qrCodeDataUrl = await generateQRCode(inputText);

    // Render the QR Code template with the qrCodeDataUrl
    res.render("qrcode", { qrCodeDataUrl });
  } catch (error) {
    console.error("QR Code generation error:", error);
    res.status(500).send("Internal server error");
  }
});

async function generateQRCode(inputText) {
  try {
    // Generate the QR Code
    const qrCodeDataUrl = await QRCode.toDataURL(inputText);

    // Return the QR Code data URL
    return qrCodeDataUrl;
  } catch (error) {
    console.error("QR Code generation error:", error);
    throw error;
  }
}

app.post("/shorturl", async (req, res) => {
  const fullUrl = req.body.fullUrl;
  if (!fullUrl) {
    return res.sendStatus(404);
  }
  if (req.session.isLogIn && req.session.userID) {
    try {
      const [result] = await dbConnection.execute(
        "SELECT * FROM `user_urls` WHERE `fullurl` = ? AND `user_id` = ?",
        [fullUrl, req.session.userID]
      );

      if (result.length === 0) {
        const short = shortid.generate();
        const qrCodeDataUrl = await generateQRCode(fullUrl); // Await here
        const url = {
          fullurl: fullUrl,
          shorturl: short,
          counts: 1,
          user_id: req.session.userID,
          qrCodeDataUrl: qrCodeDataUrl,
        };

        await dbConnection.execute(
          "INSERT INTO `user_urls` SET `fullurl` = ?, `shorturl` = ?, `counts` = ?, `user_id` = ?, `qrCodeDataUrl` = ?",
          [
            url.fullurl,
            url.shorturl,
            url.counts,
            url.user_id,
            url.qrCodeDataUrl,
          ]
        );
        console.log(`New Short URL: ${short}`);
      }
      getLinks(req, res);
    } catch (error) {
      console.log("We encountered an error:", error);
      res.sendStatus(500);
    }
  } else {
    const [result] = await dbConnection.execute(
      "SELECT * FROM `url` WHERE `fullurl` = ? ",
      [fullUrl]
    );

    if (result.length === 0) {
      const short = shortid.generate();
      const url = {
        fullurl: fullUrl,
        shorturl: short,
        counts: 1,
      };

      await dbConnection.execute(
        "INSERT INTO `url` SET `fullurl` = ?, `shorturl` = ?, `counts` = ?",
        [url.fullurl, url.shorturl, url.counts]
      );
      console.log(`New Short URL: ${shorturl}`);
    }
    getLinks(req, res);
  }
});

app.get("/:shortUrl", async (req, res) => {
  try {
    const [rows] = await dbConnection.execute(
      "SELECT * FROM `url` WHERE `shorturl` = ?",
      [req.params.shortUrl]
    );
    if (rows.length === 0) {
      res.render("error");
    } else {
      res.redirect(rows[0].fullurl);
    }
  } catch (error) {
    console.error("Database error:", error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
