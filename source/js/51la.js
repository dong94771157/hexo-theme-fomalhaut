try {
    //51.1a
    LA.init({ id: "LMkY8T98IM1tmqI3", ck: "LMkY8T98IM1tmqI3" });

    //灵雀应用监控
    new LingQue.Monitor().init({ id: "YOUR_LINGQUE_ID", sendSpaPv: true });
    //这里同样换成你的id
} catch (err) { }
