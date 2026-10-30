try {
    //51.1a
    LA.init({ id: "oYbMRDRhgE6VjYN4chcvEof9ticuToIs", ck: "xCVovhsiT1OCLFPoGdcPbMHAuxipWbfj", hashMode: true });

    //灵雀应用监控
    new LingQue.Monitor().init({ id: "YOUR_LINGQUE_ID", sendSpaPv: true });
    //这里同样换成你的id
} catch (err) { }
