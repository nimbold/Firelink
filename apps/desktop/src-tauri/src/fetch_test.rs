use reqwest;

#[tokio::main]
async fn main() {
    let url = "https://speed.hetzner.de/100MB.bin";
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .unwrap();
    let res = client.head(url).send().await.unwrap();
    println!("Status: {}", res.status());
    println!("Headers: {:?}", res.headers());
}
