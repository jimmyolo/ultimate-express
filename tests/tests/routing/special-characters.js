// must support . and - in routes

const express = require("express");

const app = express();

app.get('/test/hi.bye*a', (req, res) => {
    res.send('hi.bye');
});

app.get('/hi-bye*a', (req, res) => {
    res.send('hi-bye');
});

app.get('/test/:from--:to', (req, res) => {
    res.send(`from: ${req.params.from}, to: ${req.params.to}`);
});

app.get('/alt/:from(a|ab)-:to', (req, res) => {
    res.send(`alt from: ${req.params.from}, to: ${req.params.to}`);
});

app.get('/opt/:p(.*)-end', (req, res) => {
    res.send(`opt: ${req.params.p}`);
});

app.listen(13333, async () => {
    console.log('Server is running on port 13333');

    let res = await fetch('http://localhost:13333/test/hi.byeaa');
    console.log(await res.text());

    res = await fetch('http://localhost:13333/hi-byeaa');
    console.log(await res.text());

    res = await fetch('http://localhost:13333/test/hiAbyeaa');
    console.log(await res.text());
    
    res = await fetch('http://localhost:13333/test/123--xyz');
    console.log(await res.text());

    res = await fetch('http://localhost:13333/alt/ab-1');
    console.log(await res.text());

    // custom capture matching empty must not match before a literal (path-to-regexp parity)
    res = await fetch('http://localhost:13333/opt/-end');
    console.log('opt/-end:', res.status);

    res = await fetch('http://localhost:13333/opt/abc-end');
    console.log(await res.text());

    process.exit(0);
})
