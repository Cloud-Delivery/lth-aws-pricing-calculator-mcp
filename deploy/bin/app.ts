import { App, Tags } from 'aws-cdk-lib';
import { PricingMcpStack } from '../lib/stack';

const app = new App();
new PricingMcpStack(app, 'LthAwsPricingMcpStack', {
  env: { account: '695076071513', region: 'eu-south-1' },
});
Tags.of(app).add('Owner', 'Marco Bergantin');
Tags.of(app).add('Project', 'Copilot Studio AWS Calculator');
Tags.of(app).add('Environment', 'sandbox');
