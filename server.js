const app = require('./app');
const port = process.env.API_PORT || 8080;

app.listen(port, () => {
    console.log(`Application started on port ${port}`);
});
