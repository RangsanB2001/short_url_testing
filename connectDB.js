const mysql = require("mysql2");

const dbConnection = mysql.createPool({
  host: "localhost",
  user: "root",    
  password: "root",      
  database: "shorturl", 
  namedPlaceholders: true,
}).promise();

module.exports = dbConnection;
